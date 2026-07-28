// The desktop's closest thing to a DOM.
//
// `find` locates a picture of a button; this locates the button. Every OS
// exposes an accessibility tree - the same one screen readers use - with a
// role, a name and a rectangle for each control. That is what turns "click the
// button that says Save" into a coordinate, and it survives a theme change, a
// different font, or a window that moved, all of which defeat a template.
//
// The three trees do not agree on anything except that they exist, so the roles
// are normalised to one small vocabulary and the parsing is pure.
import type { OS } from "./os.ts";

export type Element = {
  role: string;      // normalised: button, text, label, checkbox, ...
  rawRole: string;   // what the platform called it, kept for reporting
  name: string;
  x: number; y: number; width: number; height: number;
};

export type Selector = { name?: string; role?: string };

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

/**
 * One vocabulary across three platforms. AXButton, Button and push button are
 * the same thing to someone trying to press it.
 */
/**
 * Win32 window classes, which say what a control is when UI Automation will not.
 *
 * WinForms reports every control as a generic Pane to UI Automation, so
 * `--role=button` matched nothing on Windows even though the tree was otherwise
 * correct. The managed UIA API has no way to ask the older accessibility
 * interface - trying it throws - but every one of these controls is a real Win32
 * window underneath, and its class name is exactly the missing answer.
 */
const WIN32_CLASSES: Record<string, string> = {
  button: "button", edit: "text", static: "label", combobox: "combobox",
  listbox: "list", syslistview32: "list", systreeview32: "tree",
  sysheader32: "table", msctls_progress32: "progressbar",
  msctls_trackbar32: "slider", scrollbar: "scrollbar",
  richedit20w: "text", richedit50w: "text",
  "#32770": "dialog", tabcontrol: "tab", syslink: "link",
};

/** Roles UI Automation hands back when it has nothing specific to say. */
const VAGUE = new Set(["pane", "custom", "group", "client", "unknown"]);

/**
 * Resolve a Windows role from what both sources reported.
 *
 * The wire format is `UiaType|Win32Class`. The UIA name wins when it is
 * specific, because it describes intent rather than implementation; the window
 * class is the fallback for exactly the case that motivated this.
 */
export function resolveWindowsRole(raw: string): string {
  const [uia, cls] = raw.split("|");
  const fromUia = plainRole(uia ?? "");
  if (!VAGUE.has(fromUia)) return fromUia;
  const key = (cls ?? "").trim().toLowerCase().replace(/^windowsforms10\./, "").split(".")[0] ?? "";
  return WIN32_CLASSES[key] ?? fromUia;
}

export function normalizeRole(raw: string): string {
  if (raw.includes("|")) return resolveWindowsRole(raw);
  return plainRole(raw);
}

function plainRole(raw: string): string {
  const r = raw.trim().toLowerCase().replace(/^ax/, "").replace(/[\s_-]+/g, "");
  const map: Record<string, string> = {
    button: "button", pushbutton: "button", splitbutton: "button",
    menubutton: "button", buttondropdown: "button",
    textfield: "text", edit: "text", textarea: "text", document: "text",
    searchfield: "text", combobox: "combobox",
    statictext: "label", text: "label", label: "label",
    checkbox: "checkbox", check: "checkbox",
    radiobutton: "radio", radio: "radio",
    link: "link", hyperlink: "link",
    menuitem: "menuitem", menubaritem: "menuitem", menu: "menu",
    list: "list", listitem: "listitem", table: "table", row: "row", cell: "cell",
    image: "image", tab: "tab", tabgroup: "tab", slider: "slider",
    window: "window", dialog: "dialog", sheet: "dialog",
    group: "group", pane: "group", scrollarea: "group", toolbar: "toolbar",
  };
  return map[r] ?? (r || "unknown");
}

/**
 * Ask the platform for the controls of an application's windows.
 *
 * Capped, because an accessibility tree can be enormous and an agent waiting on
 * a full walk of a browser window is an agent that has hung.
 */
export function elementsCmd(os: OS, app: string, limit = 300): string[] {
  switch (os) {
    // Attributes in bulk, asked of the container rather than of a saved list:
    // `role of kids` is not a query AppleScript can answer once the children
    // are in a variable, while `role of UI elements of el` is one Apple Event
    // for the whole row. That distinction is the difference between this
    // returning the tree and returning nothing at all. `entire contents` took over fifteen seconds on Finder and was
    // killed by cuse's own deadline; so did a per-element walk, because every
    // `role of el` is its own round trip. Asking `role of UI elements of el`
    // returns the whole list at once, which is what makes this affordable.
    case "macos": return ["osascript", "-e",
      'property seen : 0\n' +
      'on run argv\n' +
      '  set seen to 0\n' +
      '  set appName to item 1 of argv\n' +
      '  set out to ""\n' +
      '  tell application "System Events"\n' +
      '    set procs to (every application process whose name contains appName)\n' +
      '    if procs is {} then set procs to (every application process whose frontmost is true)\n' +
      '    repeat with p in procs\n' +
      '      repeat with w in (windows of p)\n' +
      '        set out to out & (my walk(w, 0))\n' +
      '      end repeat\n' +
      '    end repeat\n' +
      '  end tell\n' +
      '  return out\n' +
      'end run\n' +
      'on walk(el, depth)\n' +
      '  set out to ""\n' +
      `  if seen > ${limit} or depth > 6 then return out\n` +
      '  tell application "System Events"\n' +
      '    set kids to {}\n' +
      '    try\n' +
      '      set kids to UI elements of el\n' +
      '    end try\n' +
      '    if kids is {} then return out\n' +
      // One try per attribute: a single unsupported one used to take the whole
      // container down with it, which is how an app came back with 0 controls.
      '    set rs to {}\n' +
      '    set ns to {}\n' +
      '    set ps to {}\n' +
      '    set ss to {}\n' +
      '    try\n' +
      '      set rs to role of UI elements of el\n' +
      '    end try\n' +
      '    try\n' +
      '      set ns to name of UI elements of el\n' +
      '    end try\n' +
      '    try\n' +
      '      set ps to position of UI elements of el\n' +
      '    end try\n' +
      '    try\n' +
      '      set ss to size of UI elements of el\n' +
      '    end try\n' +
      '    try\n' +
      '      repeat with i from 1 to (count of kids)\n' +
      '        try\n' +
      '          set p to item i of ps\n' +
      '          set z to item i of ss\n' +
      '          set nm to ""\n' +
      '          try\n' +
      '            set nm to item i of ns\n' +
      '          end try\n' +
      '          if nm is missing value then set nm to ""\n' +
      '          set out to out & (item i of rs) & tab & nm & tab & (item 1 of p) & tab & (item 2 of p) & tab & (item 1 of z) & tab & (item 2 of z) & linefeed\n' +
      '          set seen to seen + 1\n' +
      '        end try\n' +
      '      end repeat\n' +
      '    end try\n' +
      '    repeat with k in kids\n' +
      `      if seen > ${limit} then exit repeat\n` +
      '      set out to out & (my walk(k, depth + 1))\n' +
      '    end repeat\n' +
      '  end tell\n' +
      '  return out\n' +
      'end walk', app];

    // UI Automation walks from the window down. ControlType.ProgrammaticName
    // arrives as "ControlType.Button", so only the tail is useful.
    case "windows": return ps(
      "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
      // The class name of the window behind each control: the managed UIA API
      // cannot reach the older accessibility interface, but this is underneath
      // every WinForms control and answers the same question.
      "if(-not ('CuseWin' -as [type])){Add-Type -Name CuseWin -Namespace '' -MemberDefinition " +
      "'[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int " +
      "GetClassName(System.IntPtr h, System.Text.StringBuilder s, int max);'};" +
      "$root=[System.Windows.Automation.AutomationElement]::RootElement;" +
      "$all=$root.FindAll('Children',[System.Windows.Automation.Condition]::TrueCondition);" +
      `$app='${app.replace(/'/g, "''")}';` +
      "$n=0;" +
      "foreach($w in $all){" +
      "if($app -and $w.Current.Name -notlike \"*$app*\"){continue}" +
      "foreach($e in $w.FindAll('Descendants',[System.Windows.Automation.Condition]::TrueCondition)){" +
      `if($n -ge ${limit}){break}` +
      "$r=$e.Current.BoundingRectangle;" +
      "if($r.Width -le 0){continue}" +
      "$t=($e.Current.ControlType.ProgrammaticName -split '\\.')[-1];" +
      // WinForms answers Pane for everything through UI Automation; the same
      // control names itself properly through the legacy interface.
      "$cls='';" +
      "try{$h=$e.Current.NativeWindowHandle;" +
      "if($h -ne 0){$sb=New-Object System.Text.StringBuilder 256;" +
      "[void][CuseWin]::GetClassName([IntPtr]$h,$sb,256);$cls=$sb.ToString()}}catch{}" +
      "Write-Output ((@(\"$t|$cls\",$e.Current.Name,[int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height)) -join \"`t\");" +
      "$n++}}");

    // AT-SPI is the Linux accessibility bus. Unlike the other two it is not
    // present by default, and an app only appears on it if its toolkit exports
    // one - so this says exactly what is missing rather than returning nothing.
    case "linux": return ["python3", "-c",
      "import sys\n" +
      "try:\n" +
      "    import pyatspi\n" +
      "except ImportError:\n" +
      "    sys.stderr.write('pyatspi not installed: apt-get install -y python3-pyatspi at-spi2-core\\n')\n" +
      "    sys.exit(1)\n" +
      "want = sys.argv[1].lower() if len(sys.argv) > 1 else ''\n" +
      "n = 0\n" +
      "def walk(node, depth):\n" +
      "    global n\n" +
      `    if n > ${limit} or depth > 12:\n` +
      "        return\n" +
      "    try:\n" +
      "        ext = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)\n" +
      "        if ext.width > 0:\n" +
      "            print('\\t'.join([node.getRoleName(), node.name or '',\n" +
      "                  str(ext.x), str(ext.y), str(ext.width), str(ext.height)]))\n" +
      "            n += 1\n" +
      "    except Exception:\n" +
      "        pass\n" +
      "    for child in node:\n" +
      "        if child is not None:\n" +
      "            walk(child, depth + 1)\n" +
      "for app in pyatspi.Registry.getDesktop(0):\n" +
      "    if app is None:\n" +
      "        continue\n" +
      "    if want and want not in (app.name or '').lower():\n" +
      "        continue\n" +
      "    walk(app, 0)\n", app];

    default: throw new Error(`elements unsupported on ${os}`);
  }
}

/** Tab-separated: role, name, x, y, width, height. */
export function parseElements(text: string): Element[] {
  const out: Element[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length < 6) continue;
    const nums = f.slice(-4).map((v) => Number(v.trim()));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [x, y, width, height] = nums as [number, number, number, number];
    if (width <= 0 || height <= 0) continue;
    const rawRole = f[0]!.trim();
    out.push({
      rawRole,
      role: normalizeRole(rawRole),
      name: f.slice(1, f.length - 4).join(" ").trim(),
      x, y, width, height,
    });
  }
  return out;
}

/**
 * Which control does this selector mean?
 *
 * Name is a case-insensitive substring, the same rule as `focus` and `windows`,
 * because an agent knows the label it read, not the exact string. Exact matches
 * win over partial ones, and among equals the smallest control wins: on macOS a
 * button's own name is often repeated on the group around it, and clicking the
 * group is clicking the wrong thing.
 */
/** Roles that do something when clicked, as opposed to merely being read. */
export const ACTIONABLE = new Set([
  "button", "link", "menuitem", "checkbox", "radio", "tab", "text", "combobox", "slider",
]);

export function pickElement(els: Element[], sel: Selector): Element | null {
  const wantName = sel.name?.toLowerCase();
  const wantRole = sel.role ? normalizeRole(sel.role) : undefined;

  const matches = els.filter((e) => {
    if (wantRole && e.role !== wantRole) return false;
    if (!wantName) return true;
    return e.name.toLowerCase().includes(wantName);
  });
  if (!matches.length) return null;

  const area = (e: Element) => e.width * e.height;
  matches.sort((a, b) => {
    if (wantName) {
      const exact = (e: Element) => (e.name.toLowerCase() === wantName ? 0 : 1);
      if (exact(a) !== exact(b)) return exact(a) - exact(b);
    }
    // A control you can press beats one you cannot. GTK exposes a button's own
    // text as a label with the same name, and clicking that label - which came
    // back with a 0,0 rectangle - pressed the top-left corner of the screen.
    if (!wantRole && ACTIONABLE.has(a.role) !== ACTIONABLE.has(b.role)) {
      return ACTIONABLE.has(a.role) ? -1 : 1;
    }
    return area(a) - area(b);
  });
  return matches[0]!;
}

/**
 * Does this tree know where anything is?
 *
 * Observed on a bare Xvfb: AT-SPI happily reported zenity's 17 controls, roles
 * and names included, and gave every one of them the rectangle 0,0. Aiming at
 * that clicks the corner of the screen with full confidence, which is worse
 * than not reading the tree at all. Several controls stacked at the origin is
 * not a layout, it is a toolkit that does not know where its window is.
 */
export function geometryLooksUsable(els: Element[]): boolean {
  const positioned = els.filter((e) => e.x !== 0 || e.y !== 0);
  return els.length <= 1 || positioned.length > 0;
}

/** The point to click: the middle of the control, or a fraction of it. */
export function pointInElement(e: Element, fx = 0.5, fy = 0.5): { x: number; y: number } {
  return { x: Math.round(e.x + e.width * fx), y: Math.round(e.y + e.height * fy) };
}

/** What to say when a selector matches nothing: the near misses, not silence. */
export function describeMisses(els: Element[], sel: Selector, keep = 8): string {
  const named = els.filter((e) => e.name);
  const pool = sel.role ? named.filter((e) => e.role === normalizeRole(sel.role!)) : named;
  const sample = (pool.length ? pool : named).slice(0, keep)
    .map((e) => `${e.role} '${e.name}'`);
  return sample.length ? sample.join(", ") : "no named controls at all";
}
