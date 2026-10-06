"""
Copies every document of the ph-google-pages index from the old OpenSearch
(host port 9201) to the current one (host port 9200) through the HTTP API.

Replaces migrate-opensearch.ps1, which copied nothing: Windows PowerShell 5.1
strips the inner double quotes of '{"query":...}' when passing it to docker,
so OpenSearch rejected the body (json_parse_exception), the response had no
hits, and the loop never ran.

Safety:
  - The old index is only read (scroll search). Nothing is deleted.
  - Documents are written with the bulk "create" action, so an existing
    document in the new index is never overwritten; re-running is safe.
  - Every bulk item is checked and each failure is reported.
  - Afterwards all IDs and every _source are compared between both indexes.

Usage:  py migrate-opensearch.py            (check, migrate, verify)
        py migrate-opensearch.py --check    (connectivity + mapping check only)
"""

import json
import sys
import urllib.error
import urllib.request

OLD = "http://localhost:9201"
NEW = "http://localhost:9200"
INDEX = "ph-google-pages"
BATCH = 100


def request(method, url, body=None, content_type="application/json"):
    data = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raise SystemExit(f"HTTP {err.code} from {method} {url}: {err.read().decode('utf-8')[:500]}")
    except urllib.error.URLError as err:
        raise SystemExit(f"Cannot reach {url}: {err.reason}")


def count(base):
    return request("GET", f"{base}/{INDEX}/_count")["count"]


def all_docs(base):
    """Yields (id, source) for every document, using a read-only scroll."""
    page = request("POST", f"{base}/{INDEX}/_search?scroll=5m", {"size": BATCH, "sort": ["_doc"]})
    scroll_id = page.get("_scroll_id")
    try:
        while page["hits"]["hits"]:
            for hit in page["hits"]["hits"]:
                yield hit["_id"], hit["_source"]
            page = request("POST", f"{base}/_search/scroll", {"scroll": "5m", "scroll_id": scroll_id})
            scroll_id = page.get("_scroll_id", scroll_id)
    finally:
        if scroll_id:
            # Frees the scroll context only; the index is untouched.
            request("DELETE", f"{base}/_search/scroll", {"scroll_id": scroll_id})


def check():
    for name, base in (("old", OLD), ("new", NEW)):
        health = request("GET", f"{base}/_cluster/health")
        print(f"{name:3} {base}  cluster={health['cluster_name']} status={health['status']}  {INDEX} count={count(base)}")

    old_map = request("GET", f"{OLD}/{INDEX}/_mapping")[INDEX]["mappings"]
    new_map = request("GET", f"{NEW}/{INDEX}/_mapping")[INDEX]["mappings"]
    if old_map != new_map:
        raise SystemExit("Mappings differ between old and new index; refusing to migrate.")
    print("mappings identical: yes")


def migrate():
    migrated, existed, failures, batch = 0, 0, [], []

    def flush():
        nonlocal migrated, existed
        if not batch:
            return
        lines = []
        for doc_id, source in batch:
            lines.append(json.dumps({"create": {"_index": INDEX, "_id": doc_id}}))
            lines.append(json.dumps(source, ensure_ascii=False))
        result = request("POST", f"{NEW}/_bulk", "\n".join(lines) + "\n", "application/x-ndjson")
        for item in result["items"]:
            op = item["create"]
            if 200 <= op["status"] < 300:
                migrated += 1
            elif op["status"] == 409:
                existed += 1  # already present from an earlier run; left untouched
            else:
                failures.append({"_id": op["_id"], "status": op["status"], "error": op.get("error")})
        print(f"  batch of {len(batch)}: migrated so far {migrated}, already present {existed}, failed {len(failures)}")
        batch.clear()

    for doc_id, source in all_docs(OLD):
        batch.append((doc_id, source))
        if len(batch) == BATCH:
            flush()
    flush()

    request("POST", f"{NEW}/{INDEX}/_refresh")
    return migrated, existed, failures


def verify():
    old_docs = dict(all_docs(OLD))
    new_docs = dict(all_docs(NEW))
    missing = sorted(set(old_docs) - set(new_docs))
    extra = sorted(set(new_docs) - set(old_docs))
    different = sorted(i for i in old_docs.keys() & new_docs.keys() if old_docs[i] != new_docs[i])
    return old_docs, new_docs, missing, extra, different


def main():
    check()
    if "--check" in sys.argv:
        return

    print(f"\nMigrating {INDEX}: {OLD} -> {NEW}")
    migrated, existed, failures = migrate()

    old_docs, new_docs, missing, extra, different = verify()
    print("\n=== Report ===")
    print(f"Old document count:            {count(OLD)}")
    print(f"New document count:            {count(NEW)}")
    print(f"Documents migrated this run:   {migrated}")
    print(f"Already present (not touched): {existed}")
    print(f"Documents failed:              {len(failures)}")
    for f in failures:
        print("  FAILED", json.dumps(f)[:400])
    print(f"IDs missing from new index:    {len(missing)} {missing[:10]}")
    print(f"IDs only in new index:         {len(extra)} {extra[:10]}")
    print(f"_source differences:           {len(different)} {different[:10]}")
    ok = not failures and not missing and not extra and not different and count(OLD) == count(NEW)
    print(f"Verification:                  {'PASSED' if ok else 'FAILED'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
