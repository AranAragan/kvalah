# Fusion scalability

The simulation uses deterministic devices in groups of 40 with different hardware, cache, temperature, traffic, RTT, duty and speed. It evaluates the actual scheduling helper. Disconnects, invalid updates, duplicate attempts and stale states are modeled counts. Actual handling of an invalid update and device revocation is verified separately in integration tests.

The largest execution created 100,000 virtual identities and proposed 50,000 tasks. Exact measurements are in the JSONL. These were in-process scheduling and simulation timings with no network or physical worker count. The modeled durations are estimates. Real coordinator API saturation and regional overlap are still to measure.
