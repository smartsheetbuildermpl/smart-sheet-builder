// Export regression suites review the new dialog without bypassing its gate or
// disabled state. Dedicated preflight tests exercise manual review/cancellation.
module.exports = async function acceptPreflight(page) {
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const dialog = document.querySelector('#printPreflight[open]');
        const proceed = dialog?.querySelector('.preflight-actions button:last-child');
        if (proceed && !proceed.disabled) proceed.click();
      }).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['open'] });
    });
  });
};
