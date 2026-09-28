# DSH plugins

Six experimental plugins for DSH. This repository contains plugin source and portable local tests; it is not an npm release or a complete DSH profile. The packages remain `private: true` to prevent accidental registry publication. The code in this repository is licensed under MIT. DSH, its official packages, Xcode, XcodeGen, and Peekaboo are separate software with their own terms.

| Plugin | Purpose | Status |
| --- | --- | --- |
| `dsh-acceptance-gate-prototype` | Frozen acceptance contracts and revision-bound process, browser, and native evidence | Prototype, exercised in local tests and campaigns |
| `dsh-rapid-iteration` | Small increments, observation checkpoints, cadence alerts, and Git restore | Experimental, exercised in local tests and campaigns |
| `dsh-competence-stop` | A bounded capability probe that stops on a knowledge, environment, or requirement gap | Experimental; no automatic documentation search |
| `dsh-native-build` | macOS Xcode project/build/launch/status/stop lifecycle | Experimental current path for DSH `v0.1.7-rc.2` with native CUA driver |
| `dsh-native-app` | macOS build plus targeted Peekaboo observation/input | Older Peekaboo fallback, macOS-specific |
| `dsh-compact-summary` | Compaction summary through a configured DSH LLM provider | Abandoned prototype; unmaintained and not qualified for production |

The rapid iteration and acceptance gate concepts were exercised in a frozen local campaign. These files were copied from the later working source tree, so this repository is **not** asserted to contain the exact bytes of that successful run. Passing the included unit tests does not establish end-to-end behavior on another DSH release, macOS version, or provider.

## Running the local tests

Use Node.js 20.11 or newer and Git. On macOS, the native-app scaffold test also requires XcodeGen at `/opt/homebrew/bin/xcodegen`; it is skipped when that binary is absent. From the repository root:

```sh
npm test
```

The tests use temporary Git workspaces and mocks for most tool results. They do not need model credentials. The older DSH integration tests from the source project are intentionally absent because they depend on a private frozen runtime, local profile, and local binaries. `dsh-native-build` and `dsh-compact-summary` do not have standalone integration coverage here.

## Mounting in a DSH profile

DSH loads plugins by package name from the selected profile's `node_modules`, then enables them through a `cordis.patch.yml` entry. Copy or link the desired `plugins/<name>` folders into that directory, keeping all six as sibling directories if using their cross-plugin imports. In particular, `dsh-native-app`, `dsh-native-build`, `dsh-competence-stop`, and `dsh-rapid-iteration` use source files from `dsh-acceptance-gate-prototype`. Their manifests declare this local dependency, but copying package folders directly does not run a package manager.

For example, after setting `DSH_PROFILE_DIR` to your profile directory:

```sh
mkdir -p "$DSH_PROFILE_DIR/node_modules"
for plugin in plugins/*; do
  cp -R "$plugin" "$DSH_PROFILE_DIR/node_modules/"
done
```

Use your DSH version's profile configuration to insert only the plugins needed for a run. Each enabled plugin needs its own configuration and, for the gate, a frozen acceptance contract. Relevant fields include `workspaceRoot`, an external `stateDir`, a unique `runId`, and, for campaign plugins, `launchPath`; inspect each plugin's `src/index.js` before enabling it. A dry configuration load and a disposable workspace test are advisable because the hook and configuration APIs are experimental. This repository does not ship a ready-to-run profile or a generic contract.

`dsh-native-build` expects the official `@deepseek-ai/dsh-computer-use` and `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` packages for screen observation and input. It was designed around DSH `v0.1.7-rc.2`; other versions have not been qualified. It handles build and process lifecycle, while the model must inspect a fresh CUA screen capture after interaction. `dsh-native-app` instead requires a compatible Peekaboo 4.6.0 binary and macOS screen/accessibility permissions; see its [plugin README](plugins/dsh-native-app/README.md). Use one native lifecycle path at a time.

`dsh-compact-summary` imports `@deepseek-ai/dsh-compaction-basic` and `@deepseek-ai/dsh-llm` from the host DSH runtime. It has no independent install or version compatibility claim. It serializes session text, including bounded tool arguments and results, and sends it to the configured summarization provider. Review that provider's data handling before enabling it.

## Operational boundaries

`dsh-rapid-iteration` requires an exclusive Git workspace marked by `.dsh-campaign-owner`; its state directory must be outside that workspace. Enabling it allows the plugin to run Git add, commit, and restore operations in that workspace. Use a disposable checkout or a workspace dedicated to that campaign. The plugin preserves a rescue commit during restore, but this is still a write operation.

The native plugins can invoke XcodeGen/Xcode, launch and stop a managed app process, and inspect process or crash information. The Peekaboo path can also dispatch UI input. A successful build, input dispatch, or screenshot receipt does not prove the intended visual outcome; inspect a fresh image and record the observed result. The competence probe likewise permits continuation only on the configured evidence and does not certify the final artifact.

No campaign logs, captured screens, model credentials, private runtime, or unrelated application source are included. The tests and metadata here are for source review and local experimentation.
