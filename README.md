# TUF Revision Spree

A browser extension for revising [Striver's A2Z DSA Sheet](https://takeuforward.org/prep-hub/strivers-a2z-dsa-sheet). Every day it gives you a random set of problems picked from the ones you've already solved, and it tracks which ones you've redone in the current revision.

The A2Z sheet only tracks whether a problem is solved. This adds a separate "revised" layer on top, so you can redo the whole sheet without losing your original ticks.

## Features

- **Daily problems:** anywhere from 1 to 20 a day (set with a slider in the panel), picked at random from the problems you've ticked on TUF.
- **Topic-balanced:** each day's problems come from different topics. The topic is never shown, so it doesn't give away the approach.
- **Fresh set every day:** anything you didn't finish goes back into the pool.
- **Stays in sync:** problems you tick on TUF join the pool automatically. Problems you untick leave it.
- **Full problem cards:** links to TUF, LeetCode, the video and the editorial, plus your bookmark status.
- **Your TUF notes:** hidden behind "Show notes" so they don't spoil the solution.
- **Revision tracking:** a "Mark revised" button (with undo) and an overall progress bar for the spree.
- **Sprees:** when everything is revised you get a summary and can start a new spree.
- **Backup / Restore:** export your progress as JSON and import it again.
- **Safe reset:** "Reset spree" is tucked under **More**. You have to type `RESET` to confirm it, and it downloads a backup first.

## Install

Works in Chrome, Brave, Edge and other Chromium browsers.

1. Clone or download this repo.
2. Open the extensions page: `chrome://extensions`, `brave://extensions` or `edge://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `tuf-revision-extension` folder.
5. Log in to [takeuforward.org](https://takeuforward.org) and open the A2Z sheet. The **Today's revision** panel appears above the topic list.

To update after pulling new changes, click the reload button on the extension's card, then refresh the sheet.

## How it works

- **Where the data comes from:** the extension runs only on `takeuforward.org`. It reads your sheet progress and notes from TUF's own backend using your existing logged-in session, which is the same data the sheet page loads.
- **What counts as the pool:** every coding problem you've ticked as solved. Learning articles are left out, so the panel's total can be lower than TUF's "problems solved" count.
- **Where progress is stored:** revision progress lives in the browser's extension storage (`chrome.storage.local`). Nothing is sent anywhere else.
- **How a day works:**
  - Today's list is picked the first time you open the sheet that day, and stays the same until midnight.
  - Topics are drawn in proportion to how many unrevised problems they have left, so the large topics don't all pile up at the end.

## Backups

Extension storage is deleted if you remove the extension, and it doesn't sync between browsers. Use **Backup** in the panel footer now and then. To move your progress to another browser, use **Restore** there with the backup file.

## Project structure

```
tuf-revision-extension/
├── manifest.json   # Manifest V3 config
├── content.js      # Panel logic: data fetching, daily picks, storage, rendering
├── panel.css       # Panel styles (dark and light)
└── icons/          # Extension icons
```

## Limitations

- **It can break if TUF changes their site.** It depends on TUF's internal API and page structure, which aren't public and can change without notice.
- **Bookmarks are read-only.** TUF bookmarks go into named lists, so you change them on TUF itself.

## Disclaimer

This is an unofficial personal project. It isn't affiliated with or endorsed by takeUforward or Striver.

## License

[MIT](LICENSE)
