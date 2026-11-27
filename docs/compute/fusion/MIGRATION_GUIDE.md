# Migration guide

Fusion is opt-in and its SQLite state is stored separately under `compute-v2/fusion`. The feature flag defaults off and is stored in the local desktop settings. Enabling it allows local UI actions. The network grant path has a separate administrator opt-in. Leave the current Compute installation and R60 artifacts in place.

The current branch has not performed an in-place desktop update or built official Expert Fusion installers. Existing Compute schema and checkpoint format were not changed. The release acceptance still needs Windows x64/macOS ARM64 clean-install and upgrade checks and verified Worker behavior on both platforms.
