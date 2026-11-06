// The only file that talks to Firebase. The SDK is loaded on demand, so a failed load or
// lost connection can't affect recording: games are always saved in the browser first.
import { firebaseConfig } from './firebaseConfig.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const COLLECTION = 'liveGames';
let loading = null;

function load() {
  loading ??= Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-auth.js`),
  ]).then(([appSdk, store, authSdk]) => {
    const app = appSdk.initializeApp(firebaseConfig);
    return { store, authSdk, db: store.getFirestore(app), auth: authSdk.getAuth(app) };
  });
  return loading;
}

export async function currentUser() {
  const { auth } = await load();
  await auth.authStateReady();
  return auth.currentUser;
}

export async function signIn() {
  const { auth, authSdk } = await load();
  const result = await authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider());
  return result.user;
}

export async function publishGame(code, liveDoc) {
  const { store, db } = await load();
  await store.setDoc(store.doc(db, COLLECTION, code), liveDoc);
}

export async function removeGame(code) {
  const { store, db } = await load();
  await store.deleteDoc(store.doc(db, COLLECTION, code));
}

/** onData(document or null, whether the server has confirmed it). */
export async function watchGame(code, { onData, onError }) {
  const { store, db } = await load();
  return store.onSnapshot(
    store.doc(db, COLLECTION, code),
    { includeMetadataChanges: true },
    (snap) => onData(snap.exists() ? snap.data() : null, !snap.metadata.fromCache),
    onError,
  );
}
