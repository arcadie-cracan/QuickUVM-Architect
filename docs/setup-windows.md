# Setup on Windows 11

QuickUVM Architect drives two Python tools: `backend/svmodel.py` (RTL parsing, on
**pyslang**) and the **`quick-uvm`** CLI (generation). Put both in **one virtualenv**
and point the extension's two settings at it. This guide assumes the `QuickUVM` and
`QuickUVM-Architect` repos are cloned side by side under `C:\dev`.

## 0. Install the tools (once)

In PowerShell:

```powershell
winget install Git.Git
winget install Python.Python.3.12       # 3.10+ required
winget install OpenJS.NodeJS.LTS         # Node 18+ (brings npm)
winget install Microsoft.VisualStudioCode
winget install GitHub.cli
```

Reopen PowerShell afterward so `PATH` updates.

**Line endings.** Both repos ship a `.gitattributes` with `* text=auto`, so history
stays LF whatever your working tree does — you do not need to configure anything.
It is deliberately not `eol=lf`: the generator writes the host's native newline
(Python emits CRLF on Windows) and the byte-identity gate compares the checked-out
`gen/` against a fresh render, so forcing an LF checkout would make them mismatch
here.

If you want the working tree to match history byte for byte as well:

```powershell
git config --global core.autocrlf false
```

If venv activation is later blocked by execution policy:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 1. Authenticate GitHub

```powershell
gh auth login          # HTTPS + browser; also wires the git credential helper
```

## 2. Clone both repos

```powershell
mkdir C:\dev; cd C:\dev
git clone https://github.com/arcadie-cracan/QuickUVM.git
git clone https://github.com/arcadie-cracan/QuickUVM-Architect.git
```

## 3. One venv for both the generator and the extension's parser

```powershell
cd C:\dev\QuickUVM
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -e ".[dev]"                     # quick-uvm CLI + pytest / ruff / mypy
pip install "pyslang>=11.0,<12"             # the extension's SV parser (prebuilt wheel)
```

Verify both entry points:

```powershell
quick-uvm --help
python C:\dev\QuickUVM-Architect\backend\svmodel.py --help
```

Optional — run the generator suite. Note that on Windows Python may write CRLF, so the
**byte-identity** test is authoritative on Linux/CI; it is the one spot expected to be
finicky here.

```powershell
pytest -q
```

## 4. Build the extension

```powershell
cd C:\dev\QuickUVM-Architect
npm install
npm run build            # dist/ is gitignored — you MUST build. Use `npm run watch` while developing.
```

## 5. Launch the Extension Development Host

1. `code C:\dev\QuickUVM-Architect`
2. Press **F5** → a second VS Code window opens with the extension loaded.
3. In that window, **open your DUT project folder** (e.g. `C:\dev\QuickUVM\examples\yapp`).

## 6. Point the extension at your venv (the key Windows step)

The extension spawns Python by absolute path, not through an activated shell, so set
these in **Settings** (User, or the workspace `.vscode/settings.json`):

```jsonc
{
  "quickuvm.python":   "C:\\dev\\QuickUVM\\.venv\\Scripts\\python.exe",
  "quickuvm.quickUvm": "C:\\dev\\QuickUVM\\.venv\\Scripts\\quick-uvm.exe"
}
```

Now *Set as DUT*, the schematic view, and *Generate Testbench* all work. (Optionally set
`quickuvm.bender` if you use Bender file lists.)

## 7. Follow the walkthrough

Open [`docs/yapp-router-walkthrough.html`](yapp-router-walkthrough.html) in a browser;
its images resolve from `docs/tutorial-shots/`.

## Simulators (only needed to *run* the generated benches)

- **Questa / ModelSim** — native Windows build; run it there.
- **Xcelium (`xrun`)** and **VCS** — **Linux-only**. Use **WSL2** (`wsl --install`, then
  clone and build on the Linux side) or a remote Linux host. All coding, parsing, and
  generation above work with no simulator installed.

## Settings reference

| Setting | Purpose | Windows value |
|---------|---------|---------------|
| `quickuvm.python`   | interpreter for the pyslang RTL parser (`backend/svmodel.py`) | `…\.venv\Scripts\python.exe` |
| `quickuvm.quickUvm` | the `quick-uvm` generator command | `…\.venv\Scripts\quick-uvm.exe` |
| `quickuvm.bender`   | Bender binary (optional, for file lists) | path to `bender.exe` |
