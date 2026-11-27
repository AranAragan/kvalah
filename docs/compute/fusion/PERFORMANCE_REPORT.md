# Fusion performance

The small synthetic CPU run records warm end-to-end training and Validation durations separately. Single-process expert training after optimizer initialization took approximately 0.06 s for 32 reference steps. The first expert recorded 1.85 s, including one-time Python optimizer initialization. Its number is not a base-model cold start. The reference measurements include no communication or GPU power sampling. Consult the committed JSON and CSV for the exact measurements.

The separate scheduler simulation measures its local control-plane wall time, while virtual training and transfer times come from model assumptions. Production cold/warm residency, switching and 3B pipeline overhead remain unmeasured.
