# Chipnet token mapping

The demo mints two CashToken categories on Chipnet so nothing here touches real
FLDCH. A production deployment maps them as follows:

| demo object | demo category | how it is created |
|---|---|---|

| reward FT — stands in for FLDCH `0adb865e…41c640` (nobody can mint in the real FLDCH category, so the pool balance needs a fresh one) | 7ce27f71745efcb5627a7ce054368e7f8adf92a38314f3bfc9b831c1c0a43e5f | genesis tx 5e8c12db8aea53ed81e644f72a11fe2e390f9271a78be948126a375a5fa3492e |
| receipt + pool-state NFT category — minted by FoldingCash at deployment | 583189b036530cf05e5cf15bd1be7add4a0055c20fa4cdeb0f022fdb42384e97 | genesis tx 4390beeecf120ecc5b3a70ce850ed1e63f74a0b258be1d6b4f0e30e271d08a39 |
