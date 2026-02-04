$body = @{
    question = "companies hiring"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:3001/api/ask" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing | Select-Object -ExpandProperty Content
