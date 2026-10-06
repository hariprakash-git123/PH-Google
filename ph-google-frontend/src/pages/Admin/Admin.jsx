import React, { useState, useEffect, useCallback, useRef } from 'react';
import AdminSidebar from '../../components/AdminSidebar/AdminSidebar';
import StatCard from '../../components/StatCard/StatCard';
import { searchApi } from '../../services/searchApi';
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Play,
  Square,
  Search as SearchIcon,
  Globe,
  Database,
  BarChart3,
  Users,
  Bot
} from 'lucide-react';
import './Admin.css';

/**
 * Admin operations console.
 *
 * Every figure on this page comes from the admin/analytics APIs, which
 * compute them from MongoDB. Nothing is hardcoded.
 */
export default function Admin() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="ph-admin-page">
      <AdminSidebar activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="ph-admin-main">
        {activeTab === 'overview' && <OverviewPanel />}
        {activeTab === 'crawlers' && <CrawlersPanel />}
        {activeTab === 'index' && <IndexPanel />}
        {activeTab === 'analytics' && <AnalyticsPanel />}
        {activeTab === 'settings' && <SystemPanel />}
      </main>
    </div>
  );
}

/** Shared loading state. */
function Loading({ label = 'Loading…' }) {
  return (
    <div className="ph-admin-loading">
      <RefreshCw size={24} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/** Shared error state with a retry affordance. */
function ErrorPanel({ message, onRetry }) {
  return (
    <div className="ph-admin-notice-banner ph-admin-notice-error" role="alert">
      <AlertCircle size={18} className="ph-notice-icon" />
      <div>
        <strong>Could not load this data</strong>
        <p>{message}</p>
        {onRetry && (
          <button type="button" className="ph-admin-action-btn" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

function AdminHeader({ title, subtitle, status }) {
  return (
    <header className="ph-admin-header">
      <div>
        <div className="ph-admin-status-badge">
          <span className={`dot ${status === 'ok' ? 'green' : 'amber'}`} />
          <span>{status === 'ok' ? 'All systems operational' : 'Check system status'}</span>
        </div>
        <h1>{title}</h1>
        <p className="ph-admin-subtitle">{subtitle}</p>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------
function OverviewPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    searchApi
      .getAdminDashboard()
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!data) return <Loading label="Loading admin console…" />;

  // Scale the chart to the busiest hour rather than a fixed ceiling.
  const maxPages = Math.max(1, ...data.crawlerActivity24h.map(b => b.pages));
  const totalCrawled24h = data.crawlerActivity24h.reduce((sum, b) => sum + b.pages, 0);

  return (
    <>
      <AdminHeader
        title="Search operations"
        subtitle="Monitor indexing, crawling, search performance and platform health."
        status="ok"
      />

      <section className="ph-admin-stats-grid">
        {data.overview.map(card => (
          <StatCard key={card.id} item={card} />
        ))}
      </section>

      <div className="ph-admin-panels-grid">
        <div className="ph-admin-panel ph-card">
          <div className="ph-panel-header">
            <div>
              <h3>Crawler activity</h3>
              <span className="ph-panel-sub">
                Pages crawled per hour · {totalCrawled24h.toLocaleString()} in the last 24h
              </span>
            </div>
            <span className="ph-range-pill">Last 24h</span>
          </div>

          {totalCrawled24h === 0 ? (
            <div className="ph-admin-empty-inline">
              No pages were crawled in the last 24 hours. Start a crawl from the Crawlers tab.
            </div>
          ) : (
            <div className="ph-crawler-chart">
              {data.crawlerActivity24h.map((bar, idx) => (
                <div key={idx} className="ph-chart-col">
                  <div className="ph-chart-bar-wrap">
                    <div
                      className="ph-chart-bar"
                      style={{ height: `${(bar.pages / maxPages) * 100}%` }}
                      title={`${bar.pages.toLocaleString()} pages at ${bar.hour}`}
                    />
                  </div>
                  <span className="ph-chart-label">{bar.hour}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ph-admin-panel ph-card">
          <div className="ph-panel-header">
            <div>
              <h3>Index health</h3>
              <span className="ph-panel-sub">
                Measured across {data.raw.totalPages.toLocaleString()} pages
              </span>
            </div>
            <CheckCircle2 size={18} className="ph-text-success" />
          </div>

          <div className="ph-health-rows-list">
            {data.indexHealth.map((row, idx) => (
              <div key={idx} className="ph-health-row">
                <div className="ph-health-row-info">
                  <span className="ph-health-label">{row.label}</span>
                  <span className="ph-health-val">{row.percentage}%</span>
                </div>
                <div className="ph-progress-track">
                  <div className="ph-progress-fill" style={{ width: `${row.percentage}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {data.raw?.verticals && (
        <section className="ph-admin-stats-grid">
          <StatCard
            item={{
              label: 'Images indexed',
              value: data.raw.verticals.images.toLocaleString(),
              change: 'Image search',
              status: 'neutral',
              subtext: 'From crawled pages'
            }}
          />
          <StatCard
            item={{
              label: 'Videos indexed',
              value: data.raw.verticals.videos.toLocaleString(),
              change: 'Video search',
              status: 'neutral',
              subtext: 'Embeds and video files'  
            }}
          />
          <StatCard
            item={{
              label: 'News articles',
              value: data.raw.verticals.news.toLocaleString(),
              change: 'News search',
              status: 'neutral',
              subtext: 'Pages with article markup'
            }}
          />
          <StatCard
            item={{
              label: 'Places',
              value: data.raw.verticals.maps.toLocaleString(),
              change: 'Map search',
              status: 'neutral',
              subtext: 'Geocoded locations'
            }}
          />
        </section>
      )}

      {data.topDomains?.length > 0 && (
        <div className="ph-admin-panel ph-card">
          <div className="ph-panel-header">
            <div>
              <h3>Top domains</h3>
              <span className="ph-panel-sub">Most-indexed hosts</span>
            </div>
            <Globe size={18} />
          </div>
          <table className="ph-admin-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Pages</th>
                <th>Last crawled</th>
              </tr>
            </thead>
            <tbody>
              {data.topDomains.map(d => (
                <tr key={d.domain}>
                  <td>{d.domain}</td>
                  <td>{d.pages.toLocaleString()}</td>
                  <td>{d.lastCrawledAt ? new Date(d.lastCrawledAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Crawlers
// ---------------------------------------------------------------------
function CrawlersPanel() {
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ seedUrl: '', maxPages: 10, sameDomainOnly: true });

  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([
        searchApi.getCrawlerStatus(),
        searchApi.getCrawlerJobs({ limit: 15 })
      ]);
      setStatus(s);
      setJobs(j.jobs);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    // Poll while a crawl is in flight so progress updates live.
    pollRef.current = setInterval(load, 3000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const handleStart = async e => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await searchApi.startCrawl({
        seedUrl: form.seedUrl.trim(),
        maxPages: Number(form.maxPages),
        sameDomainOnly: form.sameDomainOnly
      });
      setNotice(`Crawl started (job ${result.jobId.slice(-8)}). Progress updates below.`);
      setForm(f => ({ ...f, seedUrl: '' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async jobId => {
    setError(null);
    try {
      const result = await searchApi.stopCrawl(jobId);
      setNotice(result.message || 'Stop requested.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!status) return <Loading label="Loading crawler status…" />;

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued');

  return (
    <>
      <AdminHeader  
        title="Crawler control"
        subtitle="Start, monitor and stop crawl jobs. Crawls respect robots.txt and a hard page limit."
        status={status.isIdle ? 'ok' : 'busy'}
      />

      {error && <ErrorPanel message={error} />}
      {notice && (
        <div className="ph-admin-notice-banner" role="status">
          <CheckCircle2 size={18} className="ph-notice-icon" />
          <div>
            <p>{notice}</p>
          </div>
        </div>
      )}

      <section className="ph-admin-stats-grid">
        <StatCard
          item={{
            label: 'Active crawls',
            value: String(status.activeCrawls ?? status.activeJobs),
            change: status.isIdle ? 'Idle' : 'Running',
            status: status.isIdle ? 'neutral' : 'positive',
            subtext: `Max ${status.maxConcurrentJobs} concurrent`
          }}
        />
        <StatCard
          item={{
            label: 'Jobs completed',
            value: String(status.byStatus.completed),
            change: `${status.totalJobs} total`,
            status: 'positive',
            subtext: 'All time'
          }}
        />
        <StatCard
          item={{
            label: 'Pages indexed',
            value: status.lifetime.pagesIndexed.toLocaleString(),
            change: `${status.lifetime.pagesCrawled.toLocaleString()} crawled`,
            status: 'neutral',
            subtext: 'Across all jobs'
          }}
        />
        <StatCard
          item={{
            label: 'Failed',
            value: String(status.byStatus.failed),
            change:
              status.lifetime.failedPages > 0 ? `${status.lifetime.failedPages} pages` : 'None',
            status: status.byStatus.failed > 0 ? 'warning' : 'positive',
            subtext: 'Jobs / pages'
          }}
        />
      </section>

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Start a crawl</h3>
            <span className="ph-panel-sub">
              Up to {status.limits.maxPagesPerJob} pages per job · user agent{' '}
              {status.limits.userAgent}
            </span>
          </div>
          <Bot size={18} />
        </div>

        <form className="ph-crawl-form" onSubmit={handleStart}>
          <div className="ph-crawl-field ph-crawl-field-wide">
            <label htmlFor="seedUrl">Seed URL</label>
            <input
              id="seedUrl"
              type="url"
              required
              placeholder="https://example.com"
              value={form.seedUrl}
              onChange={e => setForm(f => ({ ...f, seedUrl: e.target.value }))}
            />
          </div>

          <div className="ph-crawl-field">
            <label htmlFor="maxPages">Max pages</label>
            <input
              id="maxPages"
              type="number"
              min="1"
              max={status.limits.maxPagesPerJob}
              value={form.maxPages}
              onChange={e => setForm(f => ({ ...f, maxPages: e.target.value }))}
            />
          </div>

          <div className="ph-crawl-field ph-crawl-field-check">
            <label htmlFor="sameDomainOnly">
              <input
                id="sameDomainOnly"
                type="checkbox"
                checked={form.sameDomainOnly}
                onChange={e => setForm(f => ({ ...f, sameDomainOnly: e.target.checked }))}
              />
              <span>Stay on this domain</span>
            </label>
          </div>

          <button
            type="submit"
            className="ph-admin-action-btn"
            disabled={submitting || !form.seedUrl.trim()}
          >
            {submitting ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
            <span>{submitting ? 'Starting…' : 'Start crawl'}</span>
          </button>

          {activeJobs.length > 0 && (
            <button
              type="button"
              className="ph-admin-action-btn ph-admin-action-danger"
              onClick={() => handleStop(null)}
            >
              <Square size={15} />
              <span>Stop all</span>
            </button>
          )}
        </form>
      </div>

      <TopicCrawlForm onStarted={setNotice} onError={setError} onChange={load} />

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Crawl jobs</h3>
            <span className="ph-panel-sub">Newest first · refreshes every 3s</span>
          </div>
          <span className="ph-range-pill">{jobs.length} shown</span>
        </div>

        {jobs.length === 0 ? (
          <div className="ph-admin-empty-inline">No crawl jobs yet. Start one above.</div>
        ) : (
          <table className="ph-admin-table">
            <thead>
              <tr>
                <th>Seed URL</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Indexed</th>
                <th>Failed</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => (
                <tr key={job.id}>
                  <td className="ph-td-url" title={job.seedUrl}>
                    {job.topic && <span className="ph-job-topic">{job.topic}</span>}
                    {job.seedUrl}
                  </td>
                  <td>
                    <span className={`ph-job-status ph-job-${job.status}`}>
                      {job.stopRequested && job.status === 'running' ? 'stopping' : job.status}
                    </span>
                  </td>
                  <td>
                    <div className="ph-job-progress">
                      <div className="ph-progress-track">
                        <div
                          className="ph-progress-fill"
                          style={{ width: `${job.progressPercent}%` }}
                        />
                      </div>
                      <span>
                        {job.pagesCrawled}/{job.maxPages}
                      </span>
                    </div>
                  </td>
                  <td>{job.pagesIndexed}</td>
                  <td>{job.failedPages}</td>
                  <td>{job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—'}</td>
                  <td>
                    {(job.status === 'running' || job.status === 'queued') && (
                      <button
                        type="button"
                        className="ph-admin-action-btn ph-admin-action-small ph-admin-action-danger"
                        onClick={() => handleStop(job.id)}
                      >
                        <Square size={13} />
                        <span>Stop</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * Starts a crawl of chosen topics from the backend's seed catalog
 * (config/crawlSeeds.json). Each seed becomes its own job in the table
 * below, labelled with its topic; together they count as one crawl.
 */
function TopicCrawlForm({ onStarted, onError, onChange }) {
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState([]);
  const [pagesPerSeed, setPagesPerSeed] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    searchApi
      .getCrawlerSeeds()
      .then(data => {
        setCatalog(data);
        setPagesPerSeed(String(data.limits.defaultPagesPerSeed));
      })
      .catch(err => onError(err.message));
  }, [onError]);

  if (!catalog) return null;

  const allSelected = selected.length === catalog.topics.length;
  const seedCount = catalog.topics
    .filter(t => selected.includes(t.id))
    .reduce((n, t) => n + t.seedCount, 0);
  const budget = seedCount * (Number(pagesPerSeed) || 0);
  const overBudget = budget > catalog.limits.maxPagesPerCrawl;

  const toggle = id => setSelected(s => (s.includes(id) ? s.filter(t => t !== id) : [...s, id]));

  const handleSubmit = async e => {
    e.preventDefault();
    setSubmitting(true);
    onError(null);
    try {
      const result = await searchApi.startCrawl({
        topics: allSelected ? 'all' : selected,
        maxPagesPerSeed: Number(pagesPerSeed)
      });
      onStarted(result.message);
      setSelected([]);
      await onChange();
    } catch (err) {
      onError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ph-admin-panel ph-card">
      <div className="ph-panel-header">
        <div>
          <h3>Crawl by topic</h3>
          <span className="ph-panel-sub">
            {catalog.totalSeeds} seeds across {catalog.topics.length} topics · each seed stays on
            its own allowed domains · up to {catalog.limits.maxPagesPerCrawl} pages per crawl
          </span>
        </div>
        <Globe size={18} />
      </div>

      <form className="ph-crawl-form" onSubmit={handleSubmit}>
        <div className="ph-topic-grid">
          <label className="ph-topic-chip">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? [] : catalog.topics.map(t => t.id))}
            />
            <span>All topics</span>
          </label>
          {catalog.topics.map(topic => (
            <label
              key={topic.id}
              className="ph-topic-chip"
              title={topic.seeds.map(s => s.url).join('\n')}
            >
              <input
                type="checkbox"
                checked={selected.includes(topic.id)}
                onChange={() => toggle(topic.id)}
              />
              <span>
                {topic.label} <small>({topic.seedCount})</small>
              </span>
            </label>
          ))}
        </div>

        <div className="ph-crawl-field">
          <label htmlFor="pagesPerSeed">Pages per seed</label>
          <input
            id="pagesPerSeed"
            type="number"
            min="1"
            max={catalog.limits.maxPagesPerSeed}
            value={pagesPerSeed}
            onChange={e => setPagesPerSeed(e.target.value)}
          />
        </div>

        <span className={`ph-panel-sub ph-topic-budget${overBudget ? ' ph-topic-over' : ''}`}>
          {seedCount} seeds × {Number(pagesPerSeed) || 0} = {budget} pages
          {overBudget && ` (over the ${catalog.limits.maxPagesPerCrawl} limit)`}
        </span>

        <button
          type="submit"
          className="ph-admin-action-btn"
          disabled={submitting || selected.length === 0 || overBudget || !Number(pagesPerSeed)}
        >
          {submitting ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
          <span>{submitting ? 'Starting…' : 'Crawl topics'}</span>
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------
// Index browser
// ---------------------------------------------------------------------
function IndexPanel() {
  const [pages, setPages] = useState(null);
  const [websites, setWebsites] = useState([]);
  const [searchStatus, setSearchStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reindexing, setReindexing] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      const [p, w, s] = await Promise.all([
        searchApi.getAdminPages({ page, limit: 15, q: query }),
        searchApi.getAdminWebsites({ limit: 10 }),
        // The search engine is a separate store; a failure here must not
        // hide the page list.
        searchApi.getSearchStatus().catch(() => null)
      ]);
      setPages(p);
      setWebsites(w.websites);
      setSearchStatus(s);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [page, query]);

  useEffect(() => {
    load();
  }, [load]);

  // While a rebuild runs, poll so progress is visible.
  useEffect(() => {
    if (!reindexing) return undefined;
    const timer = setInterval(async () => {
      const status = await searchApi.getReindexStatus().catch(() => null);
      if (status && !status.running) {
        setReindexing(false);
        const job = status.lastJob;
        setNotice(
          job
            ? `Reindex ${job.status}: ${job.indexed} indexed, ${job.failed} failed.`
            : 'Reindex finished.'
        );
        load();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [reindexing, load]);

  const handleReindex = async recreate => {
    setNotice(null);
    setError(null);
    try {
      await searchApi.startReindex(recreate);
      setReindexing(true);
      setNotice(
        recreate ? 'Rebuilding the search index from scratch…' : 'Refreshing the search index…'
      );
    } catch (e) {
      setError(e.message);
    }
  };

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!pages) return <Loading label="Loading index…" />;

  return (
    <>
      <AdminHeader
        title="Search index"
        subtitle="OpenSearch powers web search; MongoDB stores the crawled pages it is built from."
        status={searchStatus && searchStatus.cluster.connected ? 'ok' : 'busy'}
      />

      {notice && (
        <div className="ph-admin-notice-banner" role="status">
          {reindexing ? (
            <RefreshCw size={18} className="ph-notice-icon animate-spin" />
          ) : (
            <CheckCircle2 size={18} className="ph-notice-icon" />
          )}
          <div>
            <p>{notice}</p>
          </div>
        </div>
      )}

      {/* The search engine itself — reported honestly rather than implying
          MongoDB is the index. */}
      {searchStatus && (
        <>
          <section className="ph-admin-stats-grid">
            <StatCard
              item={{
                label: 'Search engine',
                value: searchStatus.cluster.connected ? 'OpenSearch' : 'Offline',
                change: searchStatus.cluster.connected
                  ? searchStatus.cluster.status
                  : 'Unreachable',
                status: searchStatus.cluster.connected
                  ? searchStatus.cluster.status === 'red'
                    ? 'warning'
                    : 'positive'
                  : 'warning',
                subtext: searchStatus.cluster.node
              }}
            />
            <StatCard
              item={{
                label: 'Indexed documents',
                value: (searchStatus.index.documentCount || 0).toLocaleString(),
                change: searchStatus.index.exists ? 'Index live' : 'No index',
                status: 'neutral',
                subtext: searchStatus.index.index
              }}
            />
            <StatCard
              item={{
                label: 'Index size',
                value: `${((searchStatus.index.sizeInBytes || 0) / 1024 / 1024).toFixed(1)} MB`,
                change: searchStatus.index.health || 'unknown',
                status: searchStatus.index.health === 'green' ? 'positive' : 'neutral',
                subtext: 'On disk'
              }}
            />
            <StatCard
              item={{
                label: 'MongoDB / index',
                value: searchStatus.sync
                  ? `${searchStatus.sync.mongoPages} / ${searchStatus.sync.indexedDocuments}`
                  : '—',
                change: searchStatus.sync && searchStatus.sync.inSync ? 'In sync' : 'Drifted',
                status: searchStatus.sync && searchStatus.sync.inSync ? 'positive' : 'warning',
                subtext: 'Pages vs documents'
              }}
            />
          </section>

          <div className="ph-admin-panel ph-card">
            <div className="ph-panel-header">
              <div>
                <h3>Rebuild the search index</h3>
                <span className="ph-panel-sub">
                  Re-reads every page from MongoDB and bulk-indexes it into OpenSearch. Use
                  “Rebuild” after changing the field mappings.
                </span>
              </div>
              <Database size={18} />
            </div>

            <div className="ph-crawl-form">
              <button
                type="button"
                className="ph-admin-action-btn"
                onClick={() => handleReindex(false)}
                disabled={reindexing || !searchStatus.cluster.connected}
              >
                {reindexing ? (
                  <RefreshCw size={15} className="animate-spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                <span>{reindexing ? 'Working…' : 'Refresh index'}</span>
              </button>

              <button
                type="button"
                className="ph-admin-action-btn ph-admin-action-danger"
                onClick={() => handleReindex(true)}
                disabled={reindexing || !searchStatus.cluster.connected}
              >
                <Database size={15} />
                <span>Rebuild from scratch</span>
              </button>
            </div>
          </div>
        </>
      )}

      <section className="ph-admin-stats-grid">
        <StatCard
          item={{
            label: 'Crawled pages',
            value: pages.pagination.totalResults.toLocaleString(),
            change: 'In MongoDB',
            status: 'neutral',
            subtext: 'Matching current filter'
          }}
        />
        <StatCard
          item={{
            label: 'Domains',
            value: String(websites.length),
            change: 'Top hosts',
            status: 'neutral',
            subtext: 'Shown below'
          }}
        />
      </section>

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Pages</h3>
            <span className="ph-panel-sub">
              Page {pages.pagination.page} of {Math.max(1, pages.pagination.totalPages)}
            </span>
          </div>
          <div className="ph-admin-search-box">
            <SearchIcon size={14} />
            <input
              type="text"
              placeholder="Filter by title or URL"
              value={query}
              onChange={e => {
                setPage(1);
                setQuery(e.target.value);
              }}
            />
          </div>
        </div>

        {pages.pages.length === 0 ? (
          <div className="ph-admin-empty-inline">
            No pages match. Crawl a site from the Crawlers tab to populate the index.
          </div>
        ) : (
          <>
            <table className="ph-admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Domain</th>
                  <th>Lang</th>
                  <th>Status</th>
                  <th>Last crawled</th>
                </tr>
              </thead>
              <tbody>
                {pages.pages.map(p => (
                  <tr key={p.id}>
                    <td className="ph-td-url">
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        {p.title || p.url}
                      </a>
                    </td>
                    <td>{p.domain || '—'}</td>
                    <td>{p.language || '—'}</td>
                    <td>
                      <span className={`ph-job-status ph-job-${p.status}`}>{p.status}</span>
                    </td>
                    <td>
                      {p.lastCrawledAt ? new Date(p.lastCrawledAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="ph-admin-table-nav">
              <button
                type="button"
                className="ph-admin-action-btn ph-admin-action-small"
                disabled={!pages.pagination.hasPreviousPage}
                onClick={() => setPage(p => p - 1)}
              >
                Previous
              </button>
              <span>{pages.pagination.totalResults.toLocaleString()} pages</span>
              <button
                type="button"
                className="ph-admin-action-btn ph-admin-action-small"
                disabled={!pages.pagination.hasNextPage}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Domains</h3>
            <span className="ph-panel-sub">Hosts tracked by the crawler</span>
          </div>
          <Database size={18} />
        </div>

        {websites.length === 0 ? (
          <div className="ph-admin-empty-inline">No domains tracked yet.</div>
        ) : (
          <table className="ph-admin-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Pages</th>
                <th>Indexed</th>
                <th>Status</th>
                <th>Last crawled</th>
              </tr>
            </thead>
            <tbody>
              {websites.map(w => (
                <tr key={w.id}>
                  <td>{w.domain}</td>
                  <td>{w.pages}</td>
                  <td>{w.indexedPages}</td>
                  <td>
                    <span className={`ph-job-status ph-job-${w.status}`}>{w.status}</span>
                  </td>
                  <td>{w.lastCrawledAt ? new Date(w.lastCrawledAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------
function AnalyticsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    searchApi
      .getAnalyticsOverview({ days: 30 })
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!data) return <Loading label="Loading analytics…" />;

  const maxDay = Math.max(1, ...data.searchesPerDay.map(d => d.count));

  return (
    <>
      <AdminHeader
        title="Search analytics"
        subtitle="What people search for, how fast results come back, and what the index is missing."
        status="ok"
      />

      <section className="ph-admin-stats-grid">
        <StatCard
          item={{
            label: 'Searches today',
            value: data.searchesToday.toLocaleString(),
            change: `${data.searchesThisWeek.toLocaleString()} this week`,
            status: 'neutral',
            subtext: `${data.totalSearches.toLocaleString()} all time`
          }}
        />
        <StatCard
          item={{
            label: 'Unique queries',
            value: data.uniqueQueries.toLocaleString(),
            change: 'Last 30 days',
            status: 'neutral',
            subtext: 'Distinct search terms'
          }}
        />
        <StatCard
          item={{
            label: 'Avg response',
            value: data.avgResponseTimeMs > 0 ? `${data.avgResponseTimeMs}ms` : 'No data',
            change: data.maxResponseTimeMs > 0 ? `peak ${data.maxResponseTimeMs}ms` : '—',
            status:
              data.avgResponseTimeMs > 0 && data.avgResponseTimeMs < 500 ? 'positive' : 'neutral',
            subtext: 'Search API'
          }}
        />
        <StatCard
          item={{
            label: 'Zero-result rate',
            value: `${data.zeroResultRate}%`,
            change: `${data.zeroResultSearches.toLocaleString()} searches`,
            status: data.zeroResultRate > 30 ? 'warning' : 'positive',
            subtext: 'Gaps in the index'
          }}
        />
      </section>

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Search volume</h3>
            <span className="ph-panel-sub">Searches per day</span>
          </div>
          <BarChart3 size={18} />
        </div>

        {data.searchesPerDay.length === 0 ? (
          <div className="ph-admin-empty-inline">No searches recorded yet.</div>
        ) : (
          <div className="ph-crawler-chart">
            {data.searchesPerDay.map(day => (
              <div key={day.date} className="ph-chart-col">
                <div className="ph-chart-bar-wrap">
                  <div
                    className="ph-chart-bar"
                    style={{ height: `${(day.count / maxDay) * 100}%` }}
                    title={`${day.count} searches on ${day.date} (${day.zeroResults} with no results)`}
                  />
                </div>
                <span className="ph-chart-label">{day.date.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ph-admin-panels-grid">
        <div className="ph-admin-panel ph-card">
          <div className="ph-panel-header">
            <div>
              <h3>Top queries</h3>
              <span className="ph-panel-sub">Most searched, last 30 days</span>
            </div>
          </div>
          {data.topQueries.length === 0 ? (
            <div className="ph-admin-empty-inline">No searches recorded yet.</div>
          ) : (
            <table className="ph-admin-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Count</th>
                  <th>Avg results</th>
                </tr>
              </thead>
              <tbody>
                {data.topQueries.map(q => (
                  <tr key={q.query}>
                    <td className="ph-td-url">{q.query}</td>
                    <td>{q.count}</td>
                    <td>{q.avgResults}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="ph-admin-panel ph-card">
          <div className="ph-panel-header">
            <div>
              <h3>Zero-result queries</h3>
              <span className="ph-panel-sub">Content the index is missing</span>
            </div>
            <AlertCircle size={18} />
          </div>
          {data.zeroResultQueries.length === 0 ? (
            <div className="ph-admin-empty-inline">Every search returned results.</div>
          ) : (
            <table className="ph-admin-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Count</th>
                  <th>Last searched</th>
                </tr>
              </thead>
              <tbody>
                {data.zeroResultQueries.map(q => (
                  <tr key={q.query}>
                    <td className="ph-td-url">{q.query}</td>
                    <td>{q.count}</td>
                    <td>{new Date(q.lastSearchedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// System settings / users
// ---------------------------------------------------------------------
function SystemPanel() {
  const [metrics, setMetrics] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([
        searchApi.getAdminMetrics(),
        searchApi.getAdminUsers({ limit: 20 })
      ]);
      setMetrics(m);
      setUsers(u.users);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!metrics) return <Loading label="Loading system data…" />;

  return (
    <>
      <AdminHeader title="System" subtitle="Raw platform metrics and user accounts." status="ok" />

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>Platform metrics</h3>
            <span className="ph-panel-sub">
              Computed from MongoDB at {new Date(metrics.generatedAt).toLocaleTimeString()}
            </span>
          </div>
          <Database size={18} />
        </div>

        <table className="ph-admin-table">
          <tbody>
            {[
              ['Total pages', metrics.totalPages],
              ['Fully indexed pages', metrics.indexedPages],
              ['Pages with errors', metrics.errorPages],
              ['Pages crawled (24h)', metrics.pagesCrawledLast24h],
              ['Websites tracked', metrics.totalWebsites],
              ['Unique terms in index', metrics.totalTerms],
              ['Images indexed', metrics.totalImages],
              ['Videos indexed', metrics.totalVideos],
              ['News articles', metrics.totalArticles],
              ['Places indexed', metrics.totalPlaces],
              ['Total searches', metrics.totalSearches],
              ['Searches today', metrics.searchesToday],
              ['Registered users', metrics.totalUsers],
              ['Administrators', metrics.adminUsers],
              ['Active crawl jobs', metrics.activeCrawlerJobs],
              ['Failed crawl jobs', metrics.failedCrawlJobs],
              ['Failed crawl pages', metrics.failedCrawlPages],
              ['Average search time', `${metrics.avgResponseTimeMs}ms`]
            ].map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="ph-td-number">
                  {typeof value === 'number' ? value.toLocaleString() : value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ph-admin-panel ph-card">
        <div className="ph-panel-header">
          <div>
            <h3>User accounts</h3>
            <span className="ph-panel-sub">{metrics.totalUsers} registered</span>
          </div>
          <Users size={18} />
        </div>

        <table className="ph-admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="ph-td-url">{u.email}</td>
                <td>
                  <span
                    className={`ph-job-status ph-job-${u.role === 'admin' ? 'completed' : 'queued'}`}
                  >
                    {u.role}
                  </span>
                </td>
                <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
