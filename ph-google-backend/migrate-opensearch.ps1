$scroll = docker exec ph-google-old-opensearch curl -s "http://localhost:9200/ph-google-pages/_search?scroll=5m&size=100" -H "Content-Type: application/json" -d '{"query":{"match_all":{}}}'
$scrollData = $scroll | ConvertFrom-Json
$scrollId = $scrollData._scroll_id
$total = 0

while ($scrollData.hits.hits.Count -gt 0) {
    $bulk = New-Object System.Collections.Generic.List[string]

    foreach ($hit in $scrollData.hits.hits) {
        $meta = @{ index = @{ _index = "ph-google-pages"; _id = $hit._id } } | ConvertTo-Json -Compress
        $doc = $hit._source | ConvertTo-Json -Compress -Depth 20
        $bulk.Add($meta)
        $bulk.Add($doc)
    }

    $ndjson = ($bulk -join "`n") + "`n"
    $result = $ndjson | docker exec -i ph-google-opensearch curl -s -X POST "http://localhost:9200/_bulk" -H "Content-Type: application/x-ndjson" --data-binary "@-"

    $resultData = $result | ConvertFrom-Json

    if ($resultData.errors -eq $true) {
        Write-Host "ERROR: Bulk migration returned errors."
        $resultData.items | Where-Object { $_.index.error } | ForEach-Object {
            Write-Host ($_ | ConvertTo-Json -Depth 10)
        }
        exit 1
    }

    $total += $scrollData.hits.hits.Count
    Write-Host "Migrated $total / 859 documents..."

    $scrollBody = @{ scroll = "5m"; scroll_id = $scrollId } | ConvertTo-Json -Compress
    $scrollResponse = $scrollBody | docker exec -i ph-google-old-opensearch curl -s -X POST "http://localhost:9200/_search/scroll" -H "Content-Type: application/json" --data-binary "@-"
    $scrollData = $scrollResponse | ConvertFrom-Json
    $scrollId = $scrollData._scroll_id
}

Write-Host ""
Write-Host "Migration completed. Total migrated: $total"
