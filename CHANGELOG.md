# Changelog

All notable changes to **Grok Build - Community** are documented in this file.

## [0.3.4](https://github.com/phamtanminhtien/grok-build-extension-community/compare/v0.3.3...v0.3.4) (2026-07-17)


### Features

* add shimmer effect for live assistant timeline and improve styling ([316abad](https://github.com/phamtanminhtien/grok-build-extension-community/commit/316abad112bb9675d1bb40c3ef924dab9e3e00b9))
* add TUI-style prompt queue for mid-turn follow-ups ([51ac03f](https://github.com/phamtanminhtien/grok-build-extension-community/commit/51ac03f19a77ba919ba221fda15d61891d7d95ae))


### Bug Fixes

* default grok.fs.autoSave to true ([c858e88](https://github.com/phamtanminhtien/grok-build-extension-community/commit/c858e88c192307dcf9b30a5a6befe44b11c47d63))
* show home empty state after new session ([751024b](https://github.com/phamtanminhtien/grok-build-extension-community/commit/751024b7566185170b8564abbe4dd7b5606f3bcc))
* update package.json to include repository, bugs, and homepage fields ([55d7a6b](https://github.com/phamtanminhtien/grok-build-extension-community/commit/55d7a6baf43421973da54170f63ef106dbddc810))


### Documentation

* add product demo GIF to README ([bf2fc48](https://github.com/phamtanminhtien/grok-build-extension-community/commit/bf2fc48757340e9e01d395130632f030cebc5738))
* add VS Code Marketplace and Open VSX install links ([e487f18](https://github.com/phamtanminhtien/grok-build-extension-community/commit/e487f18755ff5c66e1a356b123f2720b01900659))

## [0.3.3](https://github.com/phamtanminhtien/grok-build-extension-community/compare/v0.3.2...v0.3.3) (2026-07-16)


### Features

* update display name in README and package.json to "Grok Build Community Edition" ([bf2b7bd](https://github.com/phamtanminhtien/grok-build-extension-community/commit/bf2b7bd0fbb5b671a88b5711b7788cb5556f5019))

## [0.3.2](https://github.com/phamtanminhtien/grok-build-extension-community/compare/v0.3.1...v0.3.2) (2026-07-16)


### Features

* add Extensions editor panel for hooks, plugins, skills, MCP ([6b6faf2](https://github.com/phamtanminhtien/grok-build-extension-community/commit/6b6faf2cd264bd6a37be39b795e1b2eacb146380))
* **auth:** support browser login/logout via ACP like CLI ([541b91e](https://github.com/phamtanminhtien/grok-build-extension-community/commit/541b91ee55e82fd36bc65e47d43db08bc1f3919b))
* block agent use until Grok CLI is installed ([101b56e](https://github.com/phamtanminhtien/grok-build-extension-community/commit/101b56e67ef7e95b7ef389b035be83de8ce45538))
* **chat:** add @ mention popover above composer like grok-build TUI ([0ef1e6b](https://github.com/phamtanminhtien/grok-build-extension-community/commit/0ef1e6b0b32ab7d894b10465da79dbc690510140))
* **chat:** add message copy/edit, tool verb groups, and clean streaming ([9db0955](https://github.com/phamtanminhtien/grok-build-extension-community/commit/9db095509348f49f2deaf622f101e13df5ab2a56))
* **chat:** add Shift+Tab mode cycle like TUI ([1fee227](https://github.com/phamtanminhtien/grok-build-extension-community/commit/1fee22763e29dbcd4669dd366b2f826158a4b81a))
* **chat:** enhance assistant message handling with timeline support for text and tool events ([7b52f1a](https://github.com/phamtanminhtien/grok-build-extension-community/commit/7b52f1a95ac282b1500aedb2688178542ca6c908))
* **chat:** enhance assistant timeline with thought segments and tool details ([bad0c99](https://github.com/phamtanminhtien/grok-build-extension-community/commit/bad0c99e884c6b4c453615e9946a213a1740c194))
* **chat:** implement message chunk handling and caching for improved performance ([4d58aad](https://github.com/phamtanminhtien/grok-build-extension-community/commit/4d58aad7ea6f2e20f3d9321bbd48ec68af73c74f))
* **chat:** implement turn status tracking and context bar for usage display ([d147d9c](https://github.com/phamtanminhtien/grok-build-extension-community/commit/d147d9c9940d54dc929c27819659e23c596cce20))
* **chat:** permission/question popovers, stop button while busy ([6f310f6](https://github.com/phamtanminhtien/grok-build-extension-community/commit/6f310f6f932b17a3b880dae173106fd6818cf310))
* **chat:** show focused-file auto-attach chip with toggle ([a87729c](https://github.com/phamtanminhtien/grok-build-extension-community/commit/a87729c5d12834fd78cfa41adb36b96517fd0343))
* enhance authentication UX and sync with CLI session ([05521e5](https://github.com/phamtanminhtien/grok-build-extension-community/commit/05521e54be30bb5fb0774a8590515578aa32dd2a))
* implement slash command registry and UI integration ([6ae53b1](https://github.com/phamtanminhtien/grok-build-extension-community/commit/6ae53b1a0b7118d19bf8a2707311fdb98c8e01dd))
* **l2:** markdown, @ context, model pick, diffs, session history ([768528f](https://github.com/phamtanminhtien/grok-build-extension-community/commit/768528f357d1eaeb1895bf9ec5103eded80d1589))
* polish chat shell — new session action, loading, icon send ([acd2e30](https://github.com/phamtanminhtien/grok-build-extension-community/commit/acd2e307811cf7a70b6ef86b78839bcab5ec69df))
* rename package to grok-build-community-edition and update related references ([e827cca](https://github.com/phamtanminhtien/grok-build-extension-community/commit/e827cca5fb3b338cc6db4d8cad5c726c595e446c))
* **session:** align history list with Grok TUI sources and UI ([62564fc](https://github.com/phamtanminhtien/grok-build-extension-community/commit/62564fcd651784e394ef6fbfca6c263411a5d4aa))
* **session:** resume from ~/.grok/sessions like the TUI ([2245f63](https://github.com/phamtanminhtien/grok-build-extension-community/commit/2245f63a680398841c82a8324fbdabccf95d2812))
* test harness, virtual list helper, and sanitized markdown ([fafcaa2](https://github.com/phamtanminhtien/grok-build-extension-community/commit/fafcaa2fad9a730cc8c4afe93c243bf095064a7d))


### Bug Fixes

* **chat:** auto-load model catalog from agent like TUI ([2ce8144](https://github.com/phamtanminhtien/grok-build-extension-community/commit/2ce8144e08237c3348e998da8aa3fe2c775147df))
* **chat:** close popovers on outside click and Esc without input focus ([81816c4](https://github.com/phamtanminhtien/grok-build-extension-community/commit/81816c4f62b3f4c3b2806532c4caa568ba5235e1))
* **chat:** fix assistant copy and lighten busy turn-status colors ([0ea4e1c](https://github.com/phamtanminhtien/grok-build-extension-community/commit/0ea4e1c7fcd68ee604a19a76e929676ff2847f85))
* **session:** hide empty sessions like TUI /resume ([8bb98d4](https://github.com/phamtanminhtien/grok-build-extension-community/commit/8bb98d45d53f172b3ffc243a3306e145a5e02154))
* **ui:** stop showing session UUIDs in history and status ([c1746aa](https://github.com/phamtanminhtien/grok-build-extension-community/commit/c1746aa4967b3db419096eed6a6263bf669f99aa))
* use agent model context window for the usage bar ([4982505](https://github.com/phamtanminhtien/grok-build-extension-community/commit/4982505fd34e6355a43abe09394e4b1a0519f6d7))


### CI

* add GitHub Actions for CI and marketplace/Open VSX release ([cb853a3](https://github.com/phamtanminhtien/grok-build-extension-community/commit/cb853a34d70b1069ac8fc688d79ad39c5dfb0097))
* fix Node 22 for tests and clarify release triggers ([719e9e6](https://github.com/phamtanminhtien/grok-build-extension-community/commit/719e9e66ecdfac32584117abbe989a716a45a971))
* fix release-please summary step shell quoting ([10e4584](https://github.com/phamtanminhtien/grok-build-extension-community/commit/10e45849657ea13abab490e78dd6c8f5570301e1))
* set up Google release-please for automated version PRs ([b659b08](https://github.com/phamtanminhtien/grok-build-extension-community/commit/b659b08f8d07ac0ed701409b42403dafba4f46e1))
* switch GitHub Actions from npm to yarn ([c09e771](https://github.com/phamtanminhtien/grok-build-extension-community/commit/c09e771590d0060966853e69c317c44f9b5ed967))

## [0.3.1] — 2026-07-16

### Packaging / release readiness

- Marketplace metadata: MIT license, 128×128 icon, gallery banner, `qna`
- User-facing install notes in README (CLI prerequisite, auth, Remote-SSH)
- Security minimums: Workspace Trust gate, confirm when enabling `alwaysApprove`, explicit `shell: false` on agent spawn
- Fix TypeScript errors in interactive question option parsing
- Add `vsce` devDependency and `publish:vsce` script

### Auth UX

- Empty state shows **Log out** when signed in (not only Sign in)
- Login/logout share CLI session store (`~/.grok/auth.json`); UI watches the file so terminal `grok login` / `grok logout` stay in sync

## [0.3.0] — 2026-07-16

### Features

- L2 IDE polish: markdown chat, `@` context picker, model QuickPick, diff review, session resume/history
- Browser login/logout via ACP (aligned with CLI)
- Extensions panel (hooks / plugins / marketplace / skills / MCPs)
- Secondary Side Bar support (VS Code ≥ 1.106)
- Slash commands (host + agent pass-through)

### Known limitations

- Requires separate Grok Build CLI (`grok` on PATH or `grok.binaryPath`)
- Linux / Windows smoke incomplete vs macOS
- Binary not bundled in the VSIX
