# FedAvg optimization

MEASURED from the full 50-round R60 archive. The median ratio of the norm of the token-weighted average update to the weighted mean client norm was 0.8342. Median weighted RMS drift was 0.002457 and the median L2 difference between equal and supervised-token weighting was 0.000202. This establishes a difference in update direction and magnitude; it does not isolate a cause of NLL.

R60 Test NLL was 1.873763, sequential CUDA FedAvg 1.871097 and centralized control 1.700102. The controls began from R10 on the same rows. SGD order, per-round averaging and quantization still differ. There is no evidence yet that a larger local LR closes the gap.

Preregister a Validation-only staged search over local steps 10/20/30/50/100, local LR 0.0005/0.001/0.002/0.003 and server scale 0.5/1/2/3, then FedProx, FedAvgM, FedAdam and FedYogi under the same supervised-token budget. Use three seeds on final choices. Hold out Test until the configuration is frozen. These training runs and asynchronous staleness policies are NOT TESTED.
