// Firebase web settings are designed to be public: what protects the data is
// firestore.rules, not secrecy of these values. Set firebaseConfig to null to turn sharing
// off, and the app then makes no network requests at all.
export const firebaseConfig = {
  apiKey: 'AIzaSyCpqXcWHph3xXzqoZf9mwv6AJBOxCrWILI',
  authDomain: 'catan-tracker-e4cbf.firebaseapp.com',
  projectId: 'catan-tracker-e4cbf',
  appId: '1:370560101952:web:5bb629a0b459764058b9a5',
};

// Where players open the dashboard, ending in a slash, for example
// 'https://your-name.github.io/catan-tracker/'.
export const publicUrl = 'https://mrgriinis.github.io/catan-tracker/';
