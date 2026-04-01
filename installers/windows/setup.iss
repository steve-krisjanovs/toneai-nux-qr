#define MyAppName "toneai-nux-qr"
#define MyAppPublisher "steve-krisjanovs"
#define MyAppURL "https://github.com/steve-krisjanovs/toneai-nux-qr"
#define MyAppExeName "tnqr.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\toneai-nux-qr
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=tnqr-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; Add tnqr to PATH
ChangesEnvironment=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\tnqr-win-x64.exe"; DestDir: "{app}"; DestName: "tnqr.exe"; Flags: ignoreversion

[Registry]
; Add install dir to system PATH
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
  ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; \
  Check: NeedsAddPath(ExpandConstant('{app}'))

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path', OrigPath)
  then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;

[Icons]
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "cmd.exe"; \
  Parameters: "/C echo tnqr installed successfully. Open a new terminal and run: tnqr --help"; \
  Flags: runhidden

[Messages]
FinishedLabel=toneai-nux-qr has been installed.%n%nOpen a new Command Prompt or PowerShell and run:%n%n    tnqr --help%n%nOn first run, tnqr will guide you through setting up your Anthropic API key.
