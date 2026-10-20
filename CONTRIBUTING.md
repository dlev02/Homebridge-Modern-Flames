# Contributing

Thanks for helping. This plugin is MIT-licensed, so you're free to use, change and share it however you like.

One request: if you improve it, please send the change back here (issue or pull request) instead of
publishing a separate fork. Modern Flames owners are a small group, and one maintained plugin is much easier
to find and trust than several that drift apart. If I can't keep up with it someday, I'd rather add a
co-maintainer than see it splinter.

## Reporting a problem or a new model

Use the bug report template. Include your fireplace model and the plugin's debug log (turn on Debug for the
bridge that runs it). The `Data points reported:` line shows what your fireplace supports. Never paste your
local key.

## Making a change

```bash
npm install
npm run lint
npm test
```

- Keep the safety rules: lights and effects must never turn the fireplace on, and the write allow-list in
  `lib/mapping.js` must keep blocking factory reset (DP121), the weekly programs (DP114–120), the timer and the
  raw data points. There are tests for both; please keep them passing and add tests for new behavior.
- The tests never talk to a real fireplace. If you tested on hardware, say which model in the pull request.
- Add a line to `CHANGELOG.md` under a new "Unreleased" heading.

## Releasing (maintainer)

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Run `.\release.ps1 -Bump patch` (or `minor` / `major`) in PowerShell 7.

The script bumps the version, runs lint and tests, commits, pushes, tags, creates the GitHub release with
the CHANGELOG notes and publishes to npm. `.\release.ps1 -DryRun` runs the checks and shows the notes
without publishing anything. Finished steps are skipped, so it's safe to re-run after a failure.
