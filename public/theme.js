(() => {
  let preference = 'dark';
  try { preference = localStorage.getItem('send-local-cloud-theme') || 'dark'; } catch {}
  const media = matchMedia('(prefers-color-scheme: dark)');
  function apply(value) {
    preference = ['dark', 'light', 'system'].includes(value) ? value : 'dark';
    const dark = preference === 'dark' || (preference === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    window.chrome?.webview?.postMessage('harbor-theme:' + (dark ? 'dark' : 'light'));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#10151f' : '#f5f7fa';
    const select = document.getElementById('appearance');
    if (select) select.value = preference;
  }
  apply(preference);
  window.harborTheme = {
    get preference() { return preference; },
    set(value) { apply(value); try { localStorage.setItem('send-local-cloud-theme', preference); } catch {} }
  };
  media.addEventListener('change', () => apply(preference));
})();
