# Network report

The historical ROG declare-to-accept phase had median 103.77 s and p95 498.10 s. The archive locates the delay after declaration. It does not identify retransmission, application queueing or VPN as the cause.

The client records route class, connection wait, TLS negotiation, reuse and whether 503 originated from HTTP or local connection failure. Control and payload queues are independent. The payload circuit opens after repeated transient failures. Deadlines adapt to measured request latency within the configured bounds. Existing retry delay uses jitter and the round deadline bounds renewal.

The loopback HTTPS suite injected lost declaration, payload and commit acknowledgements, and stopped the coordinator while a worker held a finished update. Packet-drop and bandwidth sweeps in scenarios.mjs are SIMULATED transaction models.

A fresh LAN probe reached ROG on TCP 22 and 47317 three times each. Only four of 12 ICMP requests got a reply, and the existing SSH path closed before an authenticated session opened. Coordinator heartbeats from all three devices were present. ROG TCP retransmissions, bulk throughput and Ethernet/Wi-Fi/VPN comparison remain NOT TESTED. Run the LAN probe from an authenticated MSI/ROG pair after recording the chosen interface and active route.
