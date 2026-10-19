// Shared behaviour for every page: a tiny cart counter kept in localStorage.
const KEY = "static-store-cart";

function readCart() {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

function renderCart(count) {
  const badge = document.querySelector("[data-cart-count]");
  if (badge) badge.textContent = `Cart (${count})`;
}

renderCart(readCart());

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-add-to-cart]") : null;
  if (!button) return;
  const count = readCart() + 1;
  try {
    localStorage.setItem(KEY, String(count));
  } catch {
    // Storage unavailable: the counter still updates for this page view.
  }
  renderCart(count);
});
