const mongoose = require('mongoose');

/**
 * What the maintenance sweep remembers between runs.
 *
 * One document, shared by every worker. It exists so the orphan check can
 * tell "this job has been silent while the crawler was running" from "this
 * job has been silent because the crawler was not running at all". Those
 * look identical from the job's heartbeat alone: a laptop that slept for
 * twenty minutes wakes with every heartbeat twenty minutes old, and a sweep
 * that judged by the clock alone failed every crawl in flight.
 *
 * Kept in MongoDB rather than in process memory because the sweep is a queue
 * job — any worker may run any given pass — and because a restarted worker
 * must know whether the crawler was down or only it was.
 */
const crawlMaintenanceStateSchema = new mongoose.Schema(
  {
    _id: { type: String },

    // When the most recent sweep ran, from any worker.
    lastSweepAt: { type: Date, default: null },

    // Start of the current unbroken run of sweeps. Reset whenever the gap
    // between two sweeps is long enough to mean nothing was running.
    observingSince: { type: Date, default: null }
  },
  { versionKey: false }
);

module.exports = mongoose.model('CrawlMaintenanceState', crawlMaintenanceStateSchema);
