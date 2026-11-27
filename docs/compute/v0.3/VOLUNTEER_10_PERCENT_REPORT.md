# Volunteer 10% report

Cooperative mode controls a target average at synchronized microstep boundaries. The existing R60 replay at a 10% target gave 9.97% average and 11.82% peak across complete minute windows. A single synthetic 8.5-second active interval reached 14.17%. These are SIMULATED results.

Strict mode fails closed for existing CUDA and MLX because the runtime cannot certify maximum duration for model load, train and evaluation operations. At a budget of 6 seconds per 60-second window, an unbounded operation cannot be admitted. The strict setting is opt-in, with a diagnostic action in the UI. Instantaneous GPU utilization and measured power are separate from the cooperative pacing target.

The next volunteer pilot requires separate consent, verified hardware limits, an isolated coordinator and fixed Train/Validation work. The RTX 2070 and Apple M1 Pro hardware limit and comfort tests remain NOT TESTED.

The RTX 5070 residency run inserted nine seconds of idle time per second of measured command wall time, including model load. This is a conservative offline pacing experiment. It did not validate the desktop Governor against a strict rolling deadline or measure user comfort on the three-device fleet.
