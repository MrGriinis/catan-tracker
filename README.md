# Catan Tracker

A local browser app that watches a pair of dice through a fixed camera, records each throw once, and calculates statistics and resource production for a physical Catan game. Everything runs on your computer: no accounts, no network calls and no dependencies.

> **Recognition has not been tested on real dice yet.** It has only been tested on synthetic frames. Follow [Validate on real dice](#validate-on-real-dice) before trusting recorded rolls.

## Run it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm start
```

Then open http://localhost:5173 in Chrome or Edge. Browsers only allow camera access on `localhost` or HTTPS, so opening `index.html` directly won't work.

```bash
npm test
```

To try it without a camera, choose **Simulated camera** as the source. Those rolls are tagged `simulated`, so play them in a separate game from real ones.

## Player dashboard

Click **Player dashboard** on the tracker, or open http://localhost:5173/dashboard.html, and put that window on a screen everyone can see. It's read-only and shows whose turn it is, the latest roll and what it produced, each player's score and production, the board, and dice stats.

It updates instantly and follows whichever game the tracker has open. Keep the tracker visible: use a separate window, not a tab in front of the tracker, because browsers slow down hidden tabs and throw detection would lag.

The large resource numbers on each player card are what the latest roll gave that player, and the small totals beneath them cover the whole game. A dash means the roll gave nothing of that resource.

### On phones and tablets

Start the app in sharing mode instead of `npm start`:

```bash
npm run share
```

The tracker's top bar then shows an address such as `http://192.168.0.20:5173`. Players on the same Wi-Fi open that address in their browser. Hover over it on the tracker to see other addresses to try if it doesn't connect.

| Topic | How it works |
|---|---|
| What other devices can do | View the dashboard only. They can't open the tracker or change the game |
| Who can see the game | Anyone on the same network who knows the address: player names, rolls and the board. There is no password, so use it on your home network, not public Wi-Fi |
| Running the tracker | Open it on the host computer at `http://localhost:5173`, or it will be treated as another device. Keep it open, because it's what sends updates |
| Lost connection | Devices reconnect by themselves. Until then they keep the last update and show a warning that it may be out of date |

If a device can't connect:
- **Windows Firewall:** allow Node.js on private networks when prompted.
- **Network type:** the host's Wi-Fi must be set to a private network in Windows, not public.
- **Guest Wi-Fi:** many guest networks block devices from reaching each other.

A phone's screen may turn off during play, because the page can't keep it awake. It catches up when it wakes.

### Online, through GitHub Pages and Firebase

The hosted version needs no server, and its HTTPS address lets a phone act as the camera. Click **Share with players** on the tracker, sign in with Google, and send the player link.

| Topic | How it works |
|---|---|
| What goes online | Only the shared game's data: its name, player names, rolls, board and buildings. Video never leaves the device |
| When it goes online | Only after you click **Share with players**, separately for each game |
| Who can view | Anyone with the player link, without an account. Treat it like a private invite |
| Who can change it | Only the Google account that shared it, enforced by `firestore.rules` |
| Removing it | **Stop sharing** deletes the game online and turns the link off. Your copy in the browser stays |
| Without internet | The tracker keeps recording in the browser and sends the latest game when it can. Players see a warning that their screen may be out of date |

To use your own Firebase project, fill in `src/sync/firebaseConfig.js` and publish `firestore.rules` in the Firebase console. With no settings there, the app makes no network requests.

## Camera setup

| Setting | What to do | Why |
|---|---|---|
| Angle | Point the camera nearly straight down | When side faces cover about 30% of a die's width, almost every throw is rejected |
| Surface | Use a dark matte tray or cloth | Light dice must stand out: on a pale table every throw is rejected |
| Dice | Light dice with dark pips | Red or other dark dice with white pips are not supported yet |
| Dice area | Click **Set dice area** and drag around the tray | Keeps out white game pieces, cards and hands |
| Size | Aim for dice at least 25 pixels wide on the video | Tested down to 18 px, but real sensors are noisier |
| App window | Keep the tab visible | Browsers slow down background tabs, which delays detection |

With **Show what the reader sees** turned on, the video shows an outline, pip dots and value for each die. Amber means the die was found but couldn't be read.

## How throws are detected

`WAITING → MOVEMENT → SETTLING → CONFIRMED → WAITING`

| Situation | Result |
|---|---|
| Dice stay at rest for any length of time | One roll, with no duplicates |
| New throw with the same result, dice land elsewhere | A second roll |
| Hand or shadow passes, dice don't move | Ignored |
| Dice already on the table at startup | Not recorded |
| Dice picked up, table empty | No record and no alert |
| Dice nudged more than half a die's width | **Counted as a new roll.** Void it if that was wrong |
| Reading doesn't settle within about 3 seconds | No record. An alert shows the frame so you can enter the result by hand |

## Architecture

```
src/vision/   Pixels to throws. No game knowledge.
  dice.js         Finds dice, counts pips and scores confidence
  motion.js       Frame differencing
  rollDetector.js The state machine, with no pixel access
  pipeline.js     Browser glue: video to the modules above
  synth.js        Synthetic frames with known answers
  simCamera.js    Fake camera using the same video path

src/game/     Events to state. No camera knowledge.
  board.js    19 hexes, 54 intersections, 72 edges with stable ids
  rules.js    Placement rules, production, longest road, awards
  engine.js   replay(events) builds the entire game state
  stats.js    Dice statistics and CSV export
  store.js    Append-only event storage

src/ui/       HTML and SVG rendering
src/main.js   Tracker page wiring
src/dashboard.js  Player dashboard: read-only view of the same event log
```

The event log is the only source of truth, and state is always `replay(events)`:

- **Corrections and undo are new events.** Nothing is erased, and voiding a void restores the original.
- **Production is derived, not stored.** Correcting an old roll recalculates everything after it.
- **Every event records its origin:** `camera`, `manual` or `simulated`.
- **Replay re-checks the rules.** If an undo invalidates a later event, such as a city whose settlement was voided, that event is flagged on the Timeline.

Future board recognition only needs to emit the existing events, such as `SettlementBuilt` with an intersection id.

## Validate on real dice

1. Set up the camera as above and start a new game named something like "Camera test".
2. Throw the dice at least 100 times, checking each recorded value against the table. Click **Edit** on any wrong roll and **Void** on any false one. Add any missed throw by hand.
3. Read the result in the line under the **Roll history** heading: rolls kept, corrected and voided. Also count the missed throws, because that line doesn't include them.
4. Repeat under the lighting you actually play in, and with your own dice.

To test repeatably, record a video of real throws and choose **Video file…** as the source. **Frame** on a history row shows what the camera saw for that roll (current session only).

If the results are poor, use **Tuning**: raise the movement threshold if vibration or flicker triggers false throws, and raise stable frames if wrong values get confirmed.

## Not in this version

- **Board recognition.** The layout, buildings and robber are entered by hand.
- **Card inventories.** Trades, spending, steals and discards aren't tracked, so the app shows resources *produced*, never cards *held*.
- **Bank shortages.** The rule is implemented and tested, but it isn't applied because the bank's stock is unknown. Totals show what the dice entitled players to.
- **Starting resources** from the second settlement are not counted.
- **Hidden victory-point cards** are excluded from Visible VP.
- **Harbours, expansions and 5–6 player games.**
- **Phone as camera.** A phone needs HTTPS to use its camera, so for now use a webcam on the computer running the app, or record on the phone and load the video file. Phones can view the dashboard, as described above.

Inferred turns assume one roll per turn in seating order. Add a missed throw straight away: rolls are kept in the order they were recorded, so any rolls made before you add it are credited to the wrong player.

Games are stored in this browser's local storage. Export JSON to keep a backup, because clearing site data deletes them.
