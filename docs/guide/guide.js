document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  const code = button.closest('figure').querySelector('code');
  const zh = document.documentElement.lang.startsWith('zh');
  try {
    await navigator.clipboard.writeText(code.textContent);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('copy')) {
      button.textContent = zh ? '按 Ctrl/Cmd+C' : 'Press Ctrl/Cmd+C';
      return;
    }
  }
  button.textContent = zh ? '已复制' : 'Copied';
  setTimeout(() => {
    button.textContent = zh ? '复制' : 'Copy';
  }, 1200);
});
