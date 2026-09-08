document.addEventListener('DOMContentLoaded', function () {
  const accessibilityBox = document.getElementById('acessibilityBox');
  const toggleButton = document.querySelector('.acessibility-toggle-btn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  let zoomLevel = 1;

  function adjustZoom(step) {
    zoomLevel = Math.max(0.8, Math.min(2, zoomLevel + step));
    document.body.style.zoom = zoomLevel;
    document.body.style.fontSize = `${zoomLevel * 100}%`;
  }

  toggleButton.addEventListener('click', function () {
    const expanded = this.getAttribute('aria-expanded') === 'true';
    this.setAttribute('aria-expanded', String(!expanded));
    accessibilityBox.classList.toggle('active');
  });

  zoomInBtn.addEventListener('click', function () {
    adjustZoom(0.1);
  });

  zoomOutBtn.addEventListener('click', function () {
    adjustZoom(-0.1);
  });
});
