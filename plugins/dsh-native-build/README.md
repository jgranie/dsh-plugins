# dsh-native-build

General macOS project, build and process lifecycle tools for DSH. This plugin has no GUI capture or input capability. Mount it with the official `@deepseek-ai/dsh-computer-use` and `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` packages. The model uses Cua Driver's own tools to discover a window, receive a screenshot, act and observe the result.

`native_project` selects an existing Xcode project or creates a neutral SwiftUI scaffold. `native_build` builds the current revision, launches only the new product and records the exact PID/start time/executable identity in `control/native-build/receipts`; `native_status` reports lifecycle state, and `native_stop` terminates only that generation. Build logs live in `workspace/native-output/`, which is ignored by Git. Candidate build and launch commands use DSH's sandboxed shell. Read-only process inventory and narrowly scoped process termination are explicit host capabilities because DSH workspace-write denies `ps`.

The prior `dsh-native-app` plugin and pinned Peekaboo binary remain available as an inactive fallback. This plugin does not depend on them.
