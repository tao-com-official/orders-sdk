/**
 * tao.com validator hotkeys (SS58). Never applied automatically: pass one as `hotkey`
 * (or as the alpha leg `address`) to opt in.
 */
export const TAO_COM_VALIDATOR_HOTKEYS = {
  mainnet: "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN",
  testnet: "5HDmsjdFG53WG7WHjnS1HW6Eymz1BR6zgAhxXHMERFczeaAt",
} as const;

/** Testnet validator the playground and e2e suite stake with. Not exported from the package index. */
export const E2E_HOTKEY = "5CMHJBjpSCQv5r6V5cDKe8wLoJ8SGdkj9bPtw5gsPE5ENzL1";
