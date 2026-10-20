# Test-split audit — downloaded → cached → usable → scored

Every count below is read from the filesystem and the manifests by `scripts/audit_test_split.py`; none is carried by hand.

## Per method

| method | label | on disk (all splits) | in manifest (all) | test manifest | test cached | test usable | test excluded |
|--------|-------|-----------------------|------------------|---------------|--------------|-------------|---------------|
| original | real | 308 | 308 | 140 | 138 | 135 | 5 |
| Deepfakes | fake | 75 | 75 | 31 | 31 | 29 | 2 |
| Face2Face | fake | 75 | 75 | 31 | 31 | 31 | 0 |
| FaceSwap | fake | 72 | 72 | 28 | 27 | 27 | 1 |
| NeuralTextures | fake | 73 | 73 | 29 | 28 | 28 | 1 |
| **total** | | **603** | **603** | **259** | **255** | **250** | **9** |

## Exclusion reasons in the test split

| reason | n |
|--------|---|
| NO_FACE | 5 |
| NO_SIGNAL | 5 |
| MISSING_CACHE | 4 |
