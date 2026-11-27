# Peer-assisted distribution

The provisioner can try up to four explicitly supplied source callbacks, verify each chunk and fall back to the coordinator. Different sources cannot alter the signed hash, size, device scope or target version. A corrupted source and interruption test exercises fallback and recovery from cached parts.

The initial CLI only configures a coordinator download. Network peer discovery, peer serving consent, upload accounting, replication and NAT behavior still need implementation and testing. Keep Fusion grants on the private lab network.
