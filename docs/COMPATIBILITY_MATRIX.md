# Compatibility matrix

Evidence date: 2026-08-21.

| Target                          | Exact identity                                                  | Result                         | Boundary                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone/local-file           | FrogLabel review HEAD; Playwright 1.62.1; Chromium 149.0.7827.0 | Passed locally                 | Production browser artifact, local File API, no external network.                                                                                                             |
| GitHub Pages static             | `/frog_label/` production artifact                              | Passed locally                 | Exact zipped static bytes served beneath the repository prefix; no deployment performed.                                                                                      |
| ReactCode protocol harness      | protocol v1                                                     | Passed locally                 | Public host-message behavior; not a Label Studio substitute.                                                                                                                  |
| Label Studio CE                 | 1.23.0 / `2a9bfbcbf0a844b999de97e601d16050a893f5fb`             | Passed for initial local demos | Pristine production build, restricted WSGI lane, two fresh normal-HTTP/browser/database/export flows. Exact 1.23.0 only.                                                      |
| Label Studio Enterprise inline  | generated artifact manifest in review bundle                    | Compatibility only; unverified | Exact XML code is exercised only in the local inline harness. Enterprise is outside the initial POC release target, and the exact licensed website Gate 0 remains unverified. |
| Other CE or Enterprise versions | none                                                            | Unsupported/unverified         | Must fail or complete the documented exact-instance gate.                                                                                                                     |

Browser evidence uses pinned Playwright 1.62.1 and Chromium 149.0.7827.0. CE build evidence uses Node 22.x and Yarn 1.22.x; application evidence records its exact Node/npm/Python versions in the review bundle.
