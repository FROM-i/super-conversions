# Super Conversions — Windows Office/Hancom automation worker.
# Reads one JSON request per line on stdin, writes one JSON response per line on stdout.
# Keeps application instances warm between requests so batches are fast.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:word = $null
$script:excel = $null
$script:ppt = $null
$script:hwp = $null

function Has-ProgId($id) {
  try { return $null -ne [type]::GetTypeFromProgID($id) } catch { return $false }
}

function Reply($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Word {
  if ($null -eq $script:word) {
    $script:word = New-Object -ComObject Word.Application
    $script:word.Visible = $false
    $script:word.DisplayAlerts = 0
    try { $script:word.Options.UpdateLinksAtOpen = $false } catch {}
  }
  return $script:word
}
function Get-Excel {
  if ($null -eq $script:excel) {
    $script:excel = New-Object -ComObject Excel.Application
    $script:excel.Visible = $false
    $script:excel.DisplayAlerts = $false
    $script:excel.AskToUpdateLinks = $false
    $script:excel.ScreenUpdating = $false
  }
  return $script:excel
}
function Get-Ppt {
  if ($null -eq $script:ppt) {
    $script:ppt = New-Object -ComObject PowerPoint.Application
    try { $script:ppt.DisplayAlerts = 1 } catch {} # ppAlertsNone
  }
  return $script:ppt
}
function Get-Hwp {
  if ($null -eq $script:hwp) {
    $script:hwp = New-Object -ComObject HWPFrame.HwpObject
    # Security module suppresses the "allow file access?" prompt when it is registered.
    try { [void]$script:hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') } catch {}
    try { $script:hwp.XHwpWindows.Item(0).Visible = $false } catch {}
  }
  return $script:hwp
}

function Word-Save($r) {
  $w = Get-Word
  $doc = $w.Documents.Open($r.src, $false, $true, $false)
  try {
    switch ($r.format) {
      'pdf' {
        # ExportAsFixedFormat(Output, Format=17 PDF, OpenAfter, OptimizeFor=0 print, Range=0 all, From, To,
        #   Item=0 content, IncludeDocProps, KeepIRM, CreateBookmarks=1 headings, DocStructureTags, BitmapMissingFonts, UseISO19005_1)
        $doc.ExportAsFixedFormat($r.dst, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, [bool]$r.bitmapMissingFonts, $false)
      }
      'docx' { $doc.SaveAs2($r.dst, 16) }
      'doc' { $doc.SaveAs2($r.dst, 0) }
      'rtf' { $doc.SaveAs2($r.dst, 6) }
      default { throw "unknown word format $($r.format)" }
    }
  } finally { $doc.Close(0) | Out-Null }
}

function Ppt-Save($r) {
  $p = Get-Ppt
  # Open(FileName, ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse)
  $pres = $p.Presentations.Open($r.src, -1, 0, 0)
  try {
    switch ($r.format) {
      'pdf' { $pres.SaveAs($r.dst, 32) }   # ppSaveAsPDF (fonts embedded)
      'pptx' { $pres.SaveAs($r.dst, 24) }  # ppSaveAsOpenXMLPresentation
      default { throw "unknown ppt format $($r.format)" }
    }
  } finally { $pres.Close() | Out-Null }
}

function Excel-Save($r) {
  $x = Get-Excel
  $wb = $x.Workbooks.Open($r.src, 0, $true)
  try {
    if ($r.format -eq 'pdf') {
      if ($r.fit -ne 'original' -or $r.orientation -ne 'original') {
        try { $x.PrintCommunication = $false } catch {}
        foreach ($ws in $wb.Worksheets) {
          try {
            $ps = $ws.PageSetup
            if ($r.fit -eq 'onepage') { $ps.Zoom = $false; $ps.FitToPagesWide = 1; $ps.FitToPagesTall = 1 }
            elseif ($r.fit -eq 'width') { $ps.Zoom = $false; $ps.FitToPagesWide = 1; $ps.FitToPagesTall = $false }
            if ($r.orientation -eq 'portrait') { $ps.Orientation = 1 }
            elseif ($r.orientation -eq 'landscape') { $ps.Orientation = 2 }
          } catch {}
        }
        try { $x.PrintCommunication = $true } catch {}
      }
      # ExportAsFixedFormat(Type=0 PDF, Filename, Quality=0 standard, IncludeDocProperties, IgnorePrintAreas=false)
      $wb.ExportAsFixedFormat(0, $r.dst, 0, $true, $false)
    } elseif ($r.format -eq 'xlsx') {
      $wb.SaveAs($r.dst, 51)
    } elseif ($r.format -eq 'csv') {
      $wb.SaveAs($r.dst, 62) # xlCSVUTF8
    } else { throw "unknown excel format $($r.format)" }
  } finally { $wb.Close($false) | Out-Null }
}

function Hwp-Save($r) {
  $h = Get-Hwp
  $ok = $h.Open($r.src, '', 'forceopen:true;suspendpassword:true')
  if (-not $ok) { throw 'Hancom could not open the file' }
  try {
    $saved = $h.SaveAs($r.dst, $r.format, '')
    if (-not $saved) { throw "Hancom SaveAs failed ($($r.format))" }
  } finally { try { $h.Clear(1) | Out-Null } catch {} }
}

function Quit-All {
  foreach ($n in 'word', 'excel', 'ppt') {
    $a = Get-Variable -Scope Script -Name $n -ValueOnly
    if ($null -ne $a) { try { $a.Quit() | Out-Null } catch {}; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($a) } catch {} }
  }
  if ($null -ne $script:hwp) { try { $script:hwp.Quit() | Out-Null } catch {} }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $r = $line | ConvertFrom-Json
  try {
    switch ($r.op) {
      'detect' {
        Reply @{ id = $r.id; ok = $true; result = @{
          word = (Has-ProgId 'Word.Application'); excel = (Has-ProgId 'Excel.Application');
          powerpoint = (Has-ProgId 'PowerPoint.Application'); hancom = (Has-ProgId 'HWPFrame.HwpObject') } }
      }
      'word' { Word-Save $r; Reply @{ id = $r.id; ok = $true } }
      'ppt' { Ppt-Save $r; Reply @{ id = $r.id; ok = $true } }
      'excel' { Excel-Save $r; Reply @{ id = $r.id; ok = $true } }
      'hwp' { Hwp-Save $r; Reply @{ id = $r.id; ok = $true } }
      'quit' { Quit-All; Reply @{ id = $r.id; ok = $true }; $running = $false }
      default { Reply @{ id = $r.id; ok = $false; error = "unknown op $($r.op)" } }
    }
  } catch {
    Reply @{ id = $r.id; ok = $false; error = $_.Exception.Message }
  }
}
Quit-All
