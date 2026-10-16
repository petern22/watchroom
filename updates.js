// Update checks for the desktop app (main process only).
// Reads the newest public GitHub release and compares its version with the running app.
// No account and no code signing needed: it only reads public release data and opens the download page.

// Returns true when `latest` is a higher version than `current`. Accepts "v1.2.3" and "1.2.3".
function isNewer(latest, current) {
  const parse = (v) =>
    String(v || '')
      .replace(/^v/i, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Asks GitHub for the newest release of a public repository.
// Returns { status, latest, url } where status is 'current', 'available', 'none', 'error' or 'not-configured'.
async function checkForUpdate({ owner, repo, currentVersion }) {
  if (!owner || !repo) return { status: 'not-configured' };
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Watchroom' },
    });
    if (response.status === 404) return { status: 'none' };
    if (!response.ok) return { status: 'error', message: `GitHub answered ${response.status}` };
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    if (!latest) return { status: 'none' };
    if (!isNewer(latest, currentVersion)) return { status: 'current', latest };
    return { status: 'available', latest, url: release.html_url };
  } catch {
    return { status: 'error', message: 'No connection to GitHub' };
  }
}

module.exports = { isNewer, checkForUpdate };
