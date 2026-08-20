# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.2](https://github.com/Crearize/ai-dev-helm/compare/v1.10.1...v1.10.2) (2026-08-20)


### Fixed

* **superpowers:** sync skills v6.2.0 → v6.3.0 ([b7f163a](https://github.com/Crearize/ai-dev-helm/commit/b7f163aa1993dfb735304265fafccb26f620add6))

## [1.10.1](https://github.com/Crearize/ai-dev-helm/compare/v1.10.0...v1.10.1) (2026-08-20)


### Fixed

* **ci:** use legacy-peer-deps so npm ci resolves eslint 10 peers ([68240f1](https://github.com/Crearize/ai-dev-helm/commit/68240f19204b2fb688c6b99233cf71cb2cfd3c1f))
* **ci:** use legacy-peer-deps so npm ci resolves eslint 10 peers ([ef212b7](https://github.com/Crearize/ai-dev-helm/commit/ef212b7622de9bee09b80057c2122eba8fb2ebec))
* **hooks:** close quality-gate bypasses via shell tokenization and widen the control plane ([c81caa3](https://github.com/Crearize/ai-dev-helm/commit/c81caa3b79cd350baae38b62ad8a11ac1bd70bd6))
* **lib:** harden init/merge/CLI file handling ([36bf1ce](https://github.com/Crearize/ai-dev-helm/commit/36bf1ce9bc79d3ee6e6edbf86cc2732319fa0f86))
* quality-gate bypass hardening, lib fixes, and full-content review sync ([4d9761d](https://github.com/Crearize/ai-dev-helm/commit/4d9761de3401392dc9abc3c1e35de1b55fc65436))


### Documentation

* sync README, config guides and project skills with actual behavior ([bc108e5](https://github.com/Crearize/ai-dev-helm/commit/bc108e58114cb8f95176f83b525a1e746e92f723))

## [1.10.0](https://github.com/Crearize/ai-dev-helm/compare/v1.9.1...v1.10.0) (2026-08-20)


### Added

* add test-design skill (oracle-first test planning) ([3af5bb9](https://github.com/Crearize/ai-dev-helm/commit/3af5bb958f6dd1cbea3e73e0305bd5917b04eccf))
* **cli:** add lint subcommand running the cross-cutting linter ([2409b85](https://github.com/Crearize/ai-dev-helm/commit/2409b85877f4ad5232369a9a1178ab394253ccda))
* consolidate quality review into the merge gate, drop per-task reviews ([45620bd](https://github.com/Crearize/ai-dev-helm/commit/45620bd5e27701165c85977a0e68207772ce51e5))
* **hooks:** enforce gate control-plane carve-out in quality-gate hook ([9cf9de6](https://github.com/Crearize/ai-dev-helm/commit/9cf9de688ad6cddea312859787f6bcdb73344b15))
* **init:** distribute pre-built lint assets to product lint/ directory ([43ca73d](https://github.com/Crearize/ai-dev-helm/commit/43ca73dbe92378b9b47e551cd4aecdc90fbf5468))
* **lint:** add commented-code and todo-deadline checks (catalog C8) ([62a6ecf](https://github.com/Crearize/ai-dev-helm/commit/62a6ecfaa6644543384217697c76ec6c835f99c6))
* **lint:** add cross-cutting linter config loader ([2ca6a69](https://github.com/Crearize/ai-dev-helm/commit/2ca6a6927956b7da5b40233dcd0ae43152f9559e))
* **lint:** add import existence check (catalog B3, hallucinated imports) ([115b701](https://github.com/Crearize/ai-dev-helm/commit/115b701ac7eddc9d2cf4e76b241f9a6424c3d4a1))
* **lint:** add java-springboot checkstyle/archunit pre-built assets (execution-verified) ([63f5c16](https://github.com/Crearize/ai-dev-helm/commit/63f5c16b48dad9a7ae3bfef0ddc75838434971d5))
* **lint:** add lint target file collection ([e255a9b](https://github.com/Crearize/ai-dev-helm/commit/e255a9bfca4f86d6dd3c0bcb67bf8f27da823d8d))
* **lint:** add naming and commit message checks (catalog C7) ([1a0d50d](https://github.com/Crearize/ai-dev-helm/commit/1a0d50dd7bbab57ba8d4fa3d11c075623a8951b8))
* **lint:** add nextjs-react pre-built eslint/ast-grep assets ([fbd3c24](https://github.com/Crearize/ai-dev-helm/commit/fbd3c24e024ac2c7b0829f4a488909f12efdd021))
* **lint:** add pre-built generic ast-grep rules with executed fixtures ([05f16b5](https://github.com/Crearize/ai-dev-helm/commit/05f16b5e5dfddd8722e15b2e36b6744bbc0a4199))
* **lint:** add secrets check (catalog B1) ([950be6e](https://github.com/Crearize/ai-dev-helm/commit/950be6e5c7fb029ad410c33401e14051440a005e))
* **mutation:** add pre-built PIT config for java-springboot ([07f899d](https://github.com/Crearize/ai-dev-helm/commit/07f899dd991495d0498d2c847ad13b7903e295c3))
* **mutation:** add pre-built Stryker config for nextjs-react ([441193c](https://github.com/Crearize/ai-dev-helm/commit/441193cc7089a7eccccaa1c2b57cd460bead4760))
* **mutation:** phase 4 - pre-built Stryker/PIT mutation configs ([f082380](https://github.com/Crearize/ai-dev-helm/commit/f082380b3c57fb1313de1f943e95752b50560e99))
* risk-based quality gates, mutation testing, and gate-parameter carve-out (Phase 2) ([e27250e](https://github.com/Crearize/ai-dev-helm/commit/e27250ed7b559316517944875d3fa14d35cc2216))
* **skills:** add lint-scaffolding skill with coverage map ledger ([568ab7e](https://github.com/Crearize/ai-dev-helm/commit/568ab7e224a9e4933ccd1f6827f371d0b0debe36))
* wire risk-based gates, mutation step and falsification review into quality-check ([e1d347c](https://github.com/Crearize/ai-dev-helm/commit/e1d347c161fc79690304f4a4eea059a3656a6176))


### Fixed

* compare override state instead of scanning diff lines in gate-parameter carve-out ([f86b987](https://github.com/Crearize/ai-dev-helm/commit/f86b98733659b21b4cd178972520bff22dc27c9f))
* detect gate-parameter changes regardless of markdown notation ([54ca66e](https://github.com/Crearize/ai-dev-helm/commit/54ca66ecaff9268809a4a542c4c1dae1169c56cd))
* exclude gate-parameter changes from harness-only merge exemption ([31ba0f1](https://github.com/Crearize/ai-dev-helm/commit/31ba0f1e5416b1804dc3497afbf7d853512061a2))
* fail closed on ambiguous duplicate keys and oversized lines ([a924be9](https://github.com/Crearize/ai-dev-helm/commit/a924be98ee32f5b43d329d35bc632b6e134e3680))
* harden gate-parameter carve-out against notation, encoding and path bypasses ([f9aae93](https://github.com/Crearize/ai-dev-helm/commit/f9aae93682806cb6ff0040530ab3a1717e34cae0))
* **hooks:** close case-insensitive, settings.local, kill-switch, and symlink gate bypasses ([fe79628](https://github.com/Crearize/ai-dev-helm/commit/fe796283a34e74d042cd65ec6428602d117f3783))
* **hooks:** invalidate quality flag on post-flag gate control-plane changes ([94c5497](https://github.com/Crearize/ai-dev-helm/commit/94c5497bbc2abd7fb13224f701f146c4d8bfdb14))
* **lint:** add eslint security/react rules and checkstyle security group ([c125c64](https://github.com/Crearize/ai-dev-helm/commit/c125c6410c989e63528e4f23657cb469c660ed7b))
* **lint:** cover tsx/js in ast-grep rules and broaden security detections ([e9ceccc](https://github.com/Crearize/ai-dev-helm/commit/e9cecccf45dfd12e6ae8495b782b6458d91f91c2))
* **lint:** make checks string/markdown/tsconfig aware and close suppression bypasses ([6040eaf](https://github.com/Crearize/ai-dev-helm/commit/6040eafa2bc6ab5efa4cabf4dadca54894b24d33))
* **lint:** run explicitly requested checks even when default-disabled ([774c0a0](https://github.com/Crearize/ai-dev-helm/commit/774c0a074833925fb4f9a574407539bca1a2a40b))
* make override parser honor first-opened context and close remaining evasion paths ([0699192](https://github.com/Crearize/ai-dev-helm/commit/069919200ee0cad6cc575e21463c28b6f37c7d46))
* **mutation:** address merge-gate review findings ([8036d5c](https://github.com/Crearize/ai-dev-helm/commit/8036d5cf7332ae5a6875431d5323e6ef22f35af2))
* **mutation:** pin PIT core version and use classpath file in shipped config ([21b58e6](https://github.com/Crearize/ai-dev-helm/commit/21b58e618686c322eb92f0c308b690ee6d5d4ae0))
* scope Step 2 command table to static checks so area-table commands still run ([88338e9](https://github.com/Crearize/ai-dev-helm/commit/88338e96715df8d153bdbda4aabb7e4ae7de7ae9))
* **test:** restore CRLF endings in secrets crlf fixture after history rewrite ([2d46873](https://github.com/Crearize/ai-dev-helm/commit/2d468731f8772fd9c1cb750cd8ceea186ab208d0))


### Changed

* **rules:** condense rule docs covered by pre-built lint assets ([2d52fd0](https://github.com/Crearize/ai-dev-helm/commit/2d52fd0b7981c3cb053771182d053a74480053dc))


### Documentation

* add AI Quality Policy (risk levels, gates, loop protection) ([d7ff8ee](https://github.com/Crearize/ai-dev-helm/commit/d7ff8eeeb39d63be453fbcd81a33a299186c0c2d))
* add development-process loop protection and update templates ([dd9828b](https://github.com/Crearize/ai-dev-helm/commit/dd9828b92f209faa7e46215003f88b6e88de2f51))
* add risk_level, mutation, lint_cycles fields to report schema ([ac38a0f](https://github.com/Crearize/ai-dev-helm/commit/ac38a0f1270deda868f62bbfebe17e1a268424be))
* add static check standard catalog (25 categories) ([f16c059](https://github.com/Crearize/ai-dev-helm/commit/f16c05928cb9b44efce0e3f3ca54de49875b424c))
* align docs and templates with phase 3 lint foundation ([8cb8a35](https://github.com/Crearize/ai-dev-helm/commit/8cb8a35f982e7813042f50629fbc7471ca1b8c34))
* close CLAUDE.md exemption carve-out and remaining annotation gaps ([9cd257c](https://github.com/Crearize/ai-dev-helm/commit/9cd257c441622af5f64e80d5aa37fdf16cdfd83b))
* close gate-override wiring, override contract and distribution reachability gaps ([1754b14](https://github.com/Crearize/ai-dev-helm/commit/1754b1455984101d38c06babce95e5c7ecf25a36))
* close merge-gate review findings on gate semantics, lifecycle and consumers ([217a948](https://github.com/Crearize/ai-dev-helm/commit/217a948796af415930fefffebea9ea4e4fae1a86))
* close review-consolidation gaps found by reduced merge-gate review ([bc32cb3](https://github.com/Crearize/ai-dev-helm/commit/bc32cb392aeca06e6d0cb5f28f63757c937a6124))
* complete catalog coverage annotations and satellite doc alignment ([e6cdddb](https://github.com/Crearize/ai-dev-helm/commit/e6cdddb386d7244ebb0d55fccd210be0745f0db6))
* consolidate cross-references and resolve carried-over debts ([7c663dd](https://github.com/Crearize/ai-dev-helm/commit/7c663dd89114b010fcc9a6cb7d947a7ea24409a8))
* cover not-applicable paths and fix schema example details ([49de10c](https://github.com/Crearize/ai-dev-helm/commit/49de10cfd3954bbf17521a13db398ebce674782d))
* finalize report schema keys and update README flow ([ccfd52a](https://github.com/Crearize/ai-dev-helm/commit/ccfd52a0dbb53ddd6dfd931a0282a8561c96919a))
* fix catalog transition rules, paths and precedence ([912703a](https://github.com/Crearize/ai-dev-helm/commit/912703a506c75723121a48f254c15f3e4767306c))
* fix gate control-plane paths and add hook-registration files to carve-out ([f7dd909](https://github.com/Crearize/ai-dev-helm/commit/f7dd9099c35c740888078caab0a5e049b590d425))
* fix rule annotations for distribution paths and coverage accuracy ([f2b6fae](https://github.com/Crearize/ai-dev-helm/commit/f2b6fae2707338ad8bbe138797620ca9b4a54d15))
* fix schema JSON fragment and gate_override binding notes ([aaeb269](https://github.com/Crearize/ai-dev-helm/commit/aaeb269457d7d4d02dfff322c81592124c06da55))
* fix stack rule references, coverage claims and marker conventions ([bf56f0c](https://github.com/Crearize/ai-dev-helm/commit/bf56f0c97d61afaf05202ed0c568d1c2598832bd))
* flip phase-2 wiring notes from future to completed tense ([87d8f30](https://github.com/Crearize/ai-dev-helm/commit/87d8f3046535d3a7c352a4ef742695741b26542a))
* forbid duplicate override keys within a file (quality-policy §2) ([7cff55e](https://github.com/Crearize/ai-dev-helm/commit/7cff55edabe0700d105b758d06f266aaf3413bd7))
* make gate precedence one-directional and close Step 3.5 gap ([57020d2](https://github.com/Crearize/ai-dev-helm/commit/57020d2eaf50ac9b059f1043ce53e6459c355262))
* make phase-3 lint discoverable and fix coverage/lifecycle gaps ([b9a5efc](https://github.com/Crearize/ai-dev-helm/commit/b9a5efc271e3b907f35b550c0a339395e2415cdb))
* mark mutation pre-built configs as shipped (phase 4) ([ef0327f](https://github.com/Crearize/ai-dev-helm/commit/ef0327f428bf9aa5b27566e6f8118c526fd6df30))
* normalize override-key matching rule and add risk-downgrade audit trail ([8ea83b5](https://github.com/Crearize/ai-dev-helm/commit/8ea83b575d83b8a45ebcdc93f381848959892e23))
* Phase 1 quality harness foundation (quality policy, check catalog, rules restructuring) ([85b9d49](https://github.com/Crearize/ai-dev-helm/commit/85b9d4903001561066f4236e34220df9f33eb49c))
* polish catalog annotation consistency ([721c9fc](https://github.com/Crearize/ai-dev-helm/commit/721c9fcb98fd436b8eb82f52b0992a1a96211c7c))
* reconcile quality policy precedence and gate rules ([e757836](https://github.com/Crearize/ai-dev-helm/commit/e7578368dc8473f12e1d4827f0428d91840c7847))
* reference quality policy and check catalog from README ([3f5fcce](https://github.com/Crearize/ai-dev-helm/commit/3f5fcce3f006cbd99166f89861a13952f602ddff))
* resolve final review seams before merge ([03ecf3c](https://github.com/Crearize/ai-dev-helm/commit/03ecf3c3f841f9af27138a1f3026fc3729dcd70b))
* restructure generic coding rules with catalog references ([a0b23c9](https://github.com/Crearize/ai-dev-helm/commit/a0b23c942025eba7aad2009ba8fb63f0573b66f4))
* scope loop protection out of the final quality gate ([614fb1b](https://github.com/Crearize/ai-dev-helm/commit/614fb1b20d7f042e183607ae583c5a68a951cf3a))
* **skills:** wire pre-built mutation configs in lint-scaffolding ([f9aa111](https://github.com/Crearize/ai-dev-helm/commit/f9aa111e2ac52d454bb18f7075078e0a036e151e))
* split stack rules into generic vs stack-specific with catalog refs ([5a67991](https://github.com/Crearize/ai-dev-helm/commit/5a67991eaed1593fdf8997ff83a80f64d22771f5))
* sync E2E application example with revised matrix ([674c262](https://github.com/Crearize/ai-dev-helm/commit/674c2629ef8da6b0b36ed8c51b58355c7c297242))

## [1.9.1](https://github.com/Crearize/ai-dev-helm/compare/v1.9.0...v1.9.1) (2026-08-12)


### Fixed

* close quality-gate bypass and mis-resolution paths in PreToolUse hook ([a586f8f](https://github.com/Crearize/ai-dev-helm/commit/a586f8fc771e79af984ac1c4ee1ec7896d906260))
* close quality-gate bypass and mis-resolution paths in PreToolUse hook ([0b7271b](https://github.com/Crearize/ai-dev-helm/commit/0b7271b1246c7ca60c43215f3820d2b5dc7f278b))

## [1.9.0](https://github.com/Crearize/ai-dev-helm/compare/v1.8.3...v1.9.0) (2026-08-12)


### Added

* lighten quality-check cycles and bind flag to commit ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([03bf027](https://github.com/Crearize/ai-dev-helm/commit/03bf027fa460579b9c27abc2d9b27f22dd954d00))
* migrate quality gate from push to merge with commit-bound flag ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([aac209e](https://github.com/Crearize/ai-dev-helm/commit/aac209e226c4ac7ac0a706b4bc080a6c7b09bd47))
* migrate quality gate to merge-time with commit-bound flag ([635f465](https://github.com/Crearize/ai-dev-helm/commit/635f4650a32eedf16a88c22422db6992a2c5948a))


### Documentation

* align self-improvement and implementation-report with merge gate ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([40ed249](https://github.com/Crearize/ai-dev-helm/commit/40ed249f07f8c619e6782fd75d914aa6fdf7e71b))
* sweep remaining push-gate wording in README ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([d1f80e6](https://github.com/Crearize/ai-dev-helm/commit/d1f80e674744d7538cfac13f4646357fb5d69baf))
* sync harness templates with merge-gate workflow ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([e728dda](https://github.com/Crearize/ai-dev-helm/commit/e728dda936fbddd718d8794c29b72117fa64acf7))
* update gate documentation for merge-based workflow ([#70](https://github.com/Crearize/ai-dev-helm/issues/70)) ([2696148](https://github.com/Crearize/ai-dev-helm/commit/2696148198b0825f9428b240ceb91d57d06772d0))

## [1.8.3](https://github.com/Crearize/ai-dev-helm/compare/v1.8.2...v1.8.3) (2026-08-04)


### Fixed

* make quality-gate hook cross-platform via Node script ([42cc473](https://github.com/Crearize/ai-dev-helm/commit/42cc473067e0790c1e2fec15f54f3bb7250e5b2c))
* resolve template/sync inconsistencies from subagent-driven default ([5958950](https://github.com/Crearize/ai-dev-helm/commit/59589505dc398bde7c8867bc86831ef131ae2822))
* resolve template/sync inconsistencies from subagent-driven default (closes [#63](https://github.com/Crearize/ai-dev-helm/issues/63)) ([1a77e48](https://github.com/Crearize/ai-dev-helm/commit/1a77e480f911bdb286888a5642d0a335f94434aa))

## [1.8.2](https://github.com/Crearize/ai-dev-helm/compare/v1.8.1...v1.8.2) (2026-08-04)


### Fixed

* restrict Haiku instead of Sonnet in subagent model selection ([cea6a1e](https://github.com/Crearize/ai-dev-helm/commit/cea6a1e724727b0e78422f7a6eb4101f1c5db50b))
* restrict Haiku instead of Sonnet in subagent model selection ([ab57834](https://github.com/Crearize/ai-dev-helm/commit/ab578345b60168b556b24cfd17dab8982a8a1e43))

## [1.8.1](https://github.com/Crearize/ai-dev-helm/compare/v1.8.0...v1.8.1) (2026-08-04)


### Fixed

* **superpowers:** sync skills v6.1.1 → v6.2.0 ([01c19ed](https://github.com/Crearize/ai-dev-helm/commit/01c19ed11fb4455fc0832c30f238fa2c50203861))

## [1.8.0](https://github.com/Crearize/ai-dev-helm/compare/v1.7.2...v1.8.0) (2026-08-04)


### Added

* default to subagent-driven execution and update phase-based model selection (closes [#59](https://github.com/Crearize/ai-dev-helm/issues/59)) ([30b6c60](https://github.com/Crearize/ai-dev-helm/commit/30b6c60262c815ca064a346441f5f18783128181))
* サブエージェント駆動実行のデフォルト化とフェーズ別モデル選定の更新 ([0ebca11](https://github.com/Crearize/ai-dev-helm/commit/0ebca118f93a5c673db903c5b39529c9b2b8c4a5))

## [1.7.2](https://github.com/Crearize/ai-dev-helm/compare/v1.7.1...v1.7.2) (2026-07-23)


### Fixed

* make fix-nested-fences.sh executable and clean stale skill files on sync ([1d2a9e4](https://github.com/Crearize/ai-dev-helm/commit/1d2a9e43cc20bf749cc68c181778ed110ca513d5))
* make fix-nested-fences.sh executable and clean stale skill files on sync ([3e09444](https://github.com/Crearize/ai-dev-helm/commit/3e09444c12febd015a55173e10a947e3778a48ad))
* **superpowers:** sync skills to v6.1.1 ([6e53f6e](https://github.com/Crearize/ai-dev-helm/commit/6e53f6e8341044c1d7ce45efc15027afe4e69029))
* **superpowers:** sync skills v5.1.0 → v6.1.1 ([45bd23f](https://github.com/Crearize/ai-dev-helm/commit/45bd23fbfc44683157dc6af218f5ceaae650a68e))

## [1.7.1](https://github.com/Crearize/ai-dev-helm/compare/v1.7.0...v1.7.1) (2026-07-01)


### Documentation

* update model selection for Sonnet 5 and Fable 5 (closes [#51](https://github.com/Crearize/ai-dev-helm/issues/51)) ([9896f24](https://github.com/Crearize/ai-dev-helm/commit/9896f249fcfcad626e1aa9106063b294822e7d17))

## [1.7.0](https://github.com/Crearize/ai-dev-helm/compare/v1.6.0...v1.7.0) (2026-06-10)


### Added

* add subagent model selection guidance ([#37](https://github.com/Crearize/ai-dev-helm/issues/37)) ([e85583b](https://github.com/Crearize/ai-dev-helm/commit/e85583ba56a5334fc8b3041912b5bf6d3d404a37))
* optimize worktree dependency setup with lazy install and shared caches (closes [#39](https://github.com/Crearize/ai-dev-helm/issues/39)) ([#46](https://github.com/Crearize/ai-dev-helm/issues/46)) ([0b95f3a](https://github.com/Crearize/ai-dev-helm/commit/0b95f3a465287bbb4fcb94672884be48f2c230dc))
* record applied ai-dev-helm version in .ai-dev-helm.json (closes [#42](https://github.com/Crearize/ai-dev-helm/issues/42)) ([#47](https://github.com/Crearize/ai-dev-helm/issues/47)) ([369ff6d](https://github.com/Crearize/ai-dev-helm/commit/369ff6dacc04388637690d3bcfa95fc94b3ba14f))
* reduce review cost for docs/infra-only changes and add persona review guides (closes [#38](https://github.com/Crearize/ai-dev-helm/issues/38), closes [#40](https://github.com/Crearize/ai-dev-helm/issues/40)) ([#45](https://github.com/Crearize/ai-dev-helm/issues/45)) ([75d6a8c](https://github.com/Crearize/ai-dev-helm/commit/75d6a8cf226adfd377e282e3b5fb9566c66123cb))


### Fixed

* harden push gate detection and add PowerShell command rules (closes [#43](https://github.com/Crearize/ai-dev-helm/issues/43)) ([#48](https://github.com/Crearize/ai-dev-helm/issues/48)) ([5dada2a](https://github.com/Crearize/ai-dev-helm/commit/5dada2adacbbef349db93bdede545b1c687e03b1))
* recover npm publish from tlog conflicts ([#34](https://github.com/Crearize/ai-dev-helm/issues/34)) ([10bdbdd](https://github.com/Crearize/ai-dev-helm/commit/10bdbddb6e318ca20afd12e710a13c8055aab327)), closes [#33](https://github.com/Crearize/ai-dev-helm/issues/33)
* widen outer code fences nested inside prompt templates (closes [#41](https://github.com/Crearize/ai-dev-helm/issues/41)) ([#44](https://github.com/Crearize/ai-dev-helm/issues/44)) ([7c30de6](https://github.com/Crearize/ai-dev-helm/commit/7c30de618681d8d1bcadeb53b0094899d44a1b28))

## [1.6.0](https://github.com/Crearize/ai-dev-helm/compare/v1.5.0...v1.6.0) (2026-06-09)


### Added

* expand harness workflows for v1.6 ([#31](https://github.com/Crearize/ai-dev-helm/issues/31)) ([5668b70](https://github.com/Crearize/ai-dev-helm/commit/5668b70451e938bf84139d780613e4c40339c2f1))

## [1.5.0](https://github.com/Crearize/ai-dev-helm/compare/v1.4.0...v1.5.0) (2026-05-28)


### Added

* グローバル設定テンプレートのモデルを claude-opus-4-8 に更新 ([#28](https://github.com/Crearize/ai-dev-helm/issues/28)) ([a25c06b](https://github.com/Crearize/ai-dev-helm/commit/a25c06baa07304f92ab80c2909c8a561df46acad)), closes [#27](https://github.com/Crearize/ai-dev-helm/issues/27)

## [1.4.0](https://github.com/Crearize/ai-dev-helm/compare/v1.3.5...v1.4.0) (2026-05-20)


### Added

* Codex CLI 対応をハーネスに追加 ([#25](https://github.com/Crearize/ai-dev-helm/issues/25)) ([d803253](https://github.com/Crearize/ai-dev-helm/commit/d803253936ca74295e75781cffdbe3e726d30df2)), closes [#24](https://github.com/Crearize/ai-dev-helm/issues/24)

## [1.3.5](https://github.com/Crearize/ai-dev-helm/compare/v1.3.4...v1.3.5) (2026-05-17)


### Changed

* **ci:** rename release-please.yml to publish.yml ([#22](https://github.com/Crearize/ai-dev-helm/issues/22)) ([d42a8c5](https://github.com/Crearize/ai-dev-helm/commit/d42a8c5084cc0057487ac23cf08bf0d3b0ca9b0c))

## [1.3.4](https://github.com/Crearize/ai-dev-helm/compare/v1.3.3...v1.3.4) (2026-05-17)


### Fixed

* **ci:** inline publish step into release-please workflow ([#19](https://github.com/Crearize/ai-dev-helm/issues/19)) ([3737b13](https://github.com/Crearize/ai-dev-helm/commit/3737b132baaafd3b905c8c1fb394c42c3f9ef125))
* **ci:** unify publish into release-please.yml (single trusted publisher) ([#21](https://github.com/Crearize/ai-dev-helm/issues/21)) ([2838a71](https://github.com/Crearize/ai-dev-helm/commit/2838a713146b7c14daf710a3bb5a55c92f284f8b))

## [1.3.3](https://github.com/Crearize/ai-dev-helm/compare/v1.3.2...v1.3.3) (2026-05-17)


### Fixed

* **ci:** chain publish from release-please via workflow_call ([#17](https://github.com/Crearize/ai-dev-helm/issues/17)) ([739e8df](https://github.com/Crearize/ai-dev-helm/commit/739e8df4cae99481cbcc234995efbaea6cad4d74))

## [1.3.2](https://github.com/Crearize/ai-dev-helm/compare/v1.3.1...v1.3.2) (2026-05-17)


### Fixed

* **ci:** use Node 24 + latest npm for Trusted Publishing ([#14](https://github.com/Crearize/ai-dev-helm/issues/14)) ([938c463](https://github.com/Crearize/ai-dev-helm/commit/938c463af6aa1bb07c8df04a2245ff717d1f1a0d))


### CI

* introduce release-please for automated version & release PRs ([#15](https://github.com/Crearize/ai-dev-helm/issues/15)) ([8687de3](https://github.com/Crearize/ai-dev-helm/commit/8687de32b9ac66d3cd4dd0ab898b3153876990f8))

## [Unreleased]

## [1.3.1] - 2026-05-17

### Added

- **`.github/workflows/publish.yml`**: GitHub Release が `published` になった時に npm へ自動公開するワークフローを追加 (#12)
  - トリガー: `release: published`（主） / `workflow_dispatch`（手動リカバリ用）
  - リリースタグと `package.json.version` の整合性を `npm publish` 前に検証
  - publish 前に `npm ci` と `npm test` を実行して品質ゲートを担保
  - 認証は **Trusted Publishing (OIDC)** を使用（`id-token: write` 権限のみで `NPM_TOKEN` 不要）
  - `npm publish --provenance` で発行元の証明（provenance attestation）を付与

## [1.3.0] - 2026-05-17

### Changed

- superpowers スキルを v5.0.6 → v5.1.0 に同期 (#1)
  - `finishing-a-development-branch`: ワークスペース状態を判別する Step 2「Detect Environment」を追加。通常リポジトリ／named-branch worktree／detached HEAD の3パターンに応じてメニューと cleanup 処理を切り替え
  - `using-git-worktrees`: 「REQUIRED で worktree を作成」から「分離されたワークスペースを保証する（既存の worktree があれば検証する）」運用に緩和
  - `executing-plans`: `using-git-worktrees` への依存表現を緩和方針に追従
  - `requesting-code-review` / `code-reviewer.md`: レビュアー手順とプロンプト構成を刷新
  - `subagent-driven-development` / `code-quality-reviewer-prompt.md`: サブエージェント運用のガイダンスを更新
  - `systematic-debugging/root-cause-tracing.md`: 表現修正
  - `using-superpowers` / `writing-plans`: 軽微な修正

### Added

- `skills/superpowers/writing-skills/persuasion-principles.md`: スキル設計時に活用する「説得の原則」リファレンスを新規追加

## [1.2.0] - 2026-04-19

### Added

- `feature-documentation` スキル: 機能・サービス・要件・プロジェクト前提条件などを「永続ドキュメント」として蓄積する運用を必須化
  - 新規ならドキュメント作成、既存があれば更新（全面書き換え禁止）
  - 保存場所は既存ディレクトリを自動検索、なければユーザーに候補提示して確認
  - 詳細テンプレート（概要 / 目的 / スコープ / アーキテクチャ / API / データモデル / 設計判断 / 運用上の注意）。変更履歴セクションは git で追跡可能なため除外
- `quality-check` に Step 0「ドキュメント更新の確認」ゲートを追加
  - 機能変更（新規ファイル / API 変更 / 振る舞いの変更）があるのにドキュメント更新差分が `git diff` に存在しない場合はエラーで停止し、`feature-documentation` を促す
- `.quality-check-report.json` スキーマに `documentation` フィールドを追加（`status: "updated" | "not_required"`、対象ファイル一覧）

### Changed

- `shared/documents/quick-checklist.md` の「During Implementation」「Documentation Update Checks」に `feature-documentation` への参照を追加
- `README.md` のスキル一覧表に `feature-documentation` を追加

## [1.1.0] - 2026-04-09

### Added

- `personal` コマンドに Claude モデルバージョン自動検出＆アップグレード機能
  - 既存設定の `model` がテンプレートと異なる場合、対話プロンプトで確認
  - `--upgrade-model` フラグで非対話アップグレード対応
- `mergeSettings` に `upgradeKeys` オプション（指定キーをテンプレート値で強制上書き）

### Changed

- グローバル設定テンプレートのモデルを `claude-opus-4-6` → `claude-opus-4-7` に更新

## [1.0.0] - 2026-04-09

### Added

- Node.js CLI with `init` and `personal` subcommands
- Interactive setup for Claude Code and Cursor
- superpowers skills (14 development process skills)
- Project skills (8 project operation skills)
- Tech stack support: java-springboot, nextjs-react
- Shared development documents and review guides
- PR template generation
- Global safety settings for personal environments
- `--help`, `--version`, `--dry-run`, `--verbose` CLI options
- Vitest test suite (unit and integration tests)
- OSS standard files (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)
- Automated superpowers sync via GitHub Actions with auto-merge

### Security

- Input validation for project names (reject control characters)
- Safe template replacement (escape regex special characters)
- EOF handling to prevent infinite loops in prompts
- Error handling with cleanup for partial file operations
