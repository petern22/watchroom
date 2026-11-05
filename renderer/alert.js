// The desktop alert card. Text is set as plain text, never as HTML, because it comes from other people.
const params = new URLSearchParams(location.search);
document.getElementById('title').textContent = params.get('title') || 'Watchroom';
document.getElementById('text').textContent = params.get('text') || '';
