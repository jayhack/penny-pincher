# Agent Instructions

## Npm Publish Flow

When asked to publish this package to npm, use this flow by default:

1. Check the currently published version with `npm view penny-pincher version`.
2. If the local `package.json` version is already published, bump to the next patch version with `npm version <version> --no-git-tag-version`.
3. Run `rm -rf dist && npm run build`, then `npm run typecheck`.
4. Run `npm pack --dry-run` and confirm the tarball includes `dist/cli.js` and that the `bin` entry remains `penny-pincher: dist/cli.js`.
5. Publish with browser approval, not an OTP prompt, using:

   ```sh
   npm publish --access public --auth-type=web
   ```

6. When npm prints the browser-auth URL prompt, press Enter to open it and wait for the human to approve in the browser.
7. Verify the publish with `npm view penny-pincher version dist-tags.latest bin`.
8. Commit the version and related changes, then push the current branch unless the user asks for a different Git flow.

Only ask for a one-time password if npm web approval fails or the user explicitly prefers OTP.
