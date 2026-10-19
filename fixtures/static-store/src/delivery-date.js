// Renders "Arrives by <date>" using the browser's built-in Intl — the light version.
const DELIVERY_DAYS = 3;

const target = document.querySelector("[data-delivery]");
if (target) {
  const arrives = new Date(Date.now() + DELIVERY_DAYS * 24 * 60 * 60 * 1000);
  const label = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(arrives);
  target.textContent = `Arrives by ${label}`;
}
