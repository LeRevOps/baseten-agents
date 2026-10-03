// Every number here is a starting guess, meant to be tuned with the sales team on real data.
export const SPIKE_CONFIG = {
  liftThreshold: 1.5,          // recent 14-day avg must be 1.5x the prior 28-day avg
  minAbsIncrease: 500,         // ...and up by at least 500 GPU minutes/day (ignores tiny accounts)
  cooldownDays: 14,            // don't re-alert the same account within this window...
  reAlertLiftMultiplier: 1.5,  // ...unless the lift grew 1.5x since the last alert
  minConfidence: 0.7,          // below this, Claude's call goes to RevOps instead of the rep
  clayTimeout: "10m",          // how long to wait for Clay before continuing without it
  nudgeAfter: "48h",           // set to "2m" when demoing the follow-up live
} as const;
