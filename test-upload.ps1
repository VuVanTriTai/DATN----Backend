$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5OTY4OWQxZGQ5N2I0YmY1ODUyYzExNSIsImlhdCI6MTc4MTQ2Mzc3OCwiZXhwIjoxNzgxNDY3Mzc4fQ.oGsQVfL90OLivEHzNPAfYxl1W8UGDpWw5O1GyMSEovY"
$filePath = "uploads\temp\1778557237614-DB - Lesson 03.docx"

$headers = @{
    "Authorization" = "Bearer $token"
}

$Form = @{
    "file" = Get-Item $filePath
}

try {
    $response = Invoke-RestMethod -Uri "http://localhost:5000/api/file/extract" -Method Post -Form $Form -Headers $headers
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Error $_
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.ReadToEnd()
    }
}
