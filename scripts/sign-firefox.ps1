# Signs the Firefox build with Mozilla using the AMO API key
# stored in Windows Credential Manager under "tether-amo".
# Store it once:  cmdkey /generic:tether-amo /user:<JWT issuer> /pass:<JWT secret>
# Then run:       powershell -File scripts/sign-firefox.ps1   (unlisted: writes dist/tether-<version>.xpi)
#                 powershell -File scripts/sign-firefox.ps1 -Channel listed   (submits to the public listing for review)
param([ValidateSet("unlisted", "listed")] [string]$Channel = "unlisted")
$ErrorActionPreference = "Stop"
Add-Type -Namespace Win -Name Cred -MemberDefinition @"
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredRead(string target, int type, int flags, out System.IntPtr cred);
[DllImport("advapi32.dll")] public static extern void CredFree(System.IntPtr cred);
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public System.IntPtr CredentialBlob;
  public int Persist; public int AttributeCount; public System.IntPtr Attributes; public string TargetAlias; public string UserName; }
"@
$p = [IntPtr]::Zero
if (-not [Win.Cred]::CredRead("tether-amo", 1, 0, [ref]$p)) { throw "No 'tether-amo' credential. Store it with cmdkey first (see the top of this script)." }
try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Win.Cred+CREDENTIAL])
  $env:WEB_EXT_API_KEY = $c.UserName
  $env:WEB_EXT_API_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
} finally { [Win.Cred]::CredFree($p) }
Set-Location (Split-Path $PSScriptRoot)
node scripts/build-ext.js
# A listed version carries its release notes and the notes for Mozilla's reviewers.
$notes = @()
if ($Channel -eq "listed" -and (Test-Path store/amo-version.json)) { $notes = @("--amo-metadata", "store/amo-version.json") }
npx --yes web-ext@8 sign -s dist/firefox -a dist --channel $Channel @notes
