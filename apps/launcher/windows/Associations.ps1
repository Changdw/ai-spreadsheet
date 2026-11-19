function Register-AibWorkbookAssociation([Microsoft.Win32.RegistryKey]$Classes, [string]$Exe) {
    $values = [ordered]@{
        'AIB.Workbook' = 'AIB Workbook'
        'AIB.Workbook\shell\open\command' = ('"' + $Exe + '" "%1"')
        'AIB.Workbook\DefaultIcon' = ('"' + $Exe + '",0')
    }
    foreach ($path in $values.Keys) {
        $key = $Classes.CreateSubKey($path)
        try { $key.SetValue('', $values[$path]) } finally { $key.Dispose() }
    }
    $openWith = $Classes.CreateSubKey('.aib\OpenWithProgids')
    try { $openWith.SetValue('AIB.Workbook', '', [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $openWith.Dispose() }
}

function Unregister-AibWorkbookAssociation([Microsoft.Win32.RegistryKey]$Classes, [string]$Exe) {
    $command = $Classes.OpenSubKey('AIB.Workbook\shell\open\command')
    if (!$command) { return $false }
    try { $owned = $command.GetValue('') -eq ('"' + $Exe + '" "%1"') }
    finally { $command.Dispose() }
    if (!$owned) { return $false }

    $extension = $Classes.OpenSubKey('.aib', $true)
    if ($extension) {
        try {
            # Older AIB installers wrote this default directly.
            if ($extension.GetValue('') -eq 'AIB.Workbook') { $extension.DeleteValue('', $false) }
            $openWith = $extension.OpenSubKey('OpenWithProgids', $true)
            if ($openWith) {
                try { $openWith.DeleteValue('AIB.Workbook', $false) } finally { $openWith.Dispose() }
            }
        } finally { $extension.Dispose() }
    }
    $Classes.DeleteSubKeyTree('AIB.Workbook')
    return $true
}
