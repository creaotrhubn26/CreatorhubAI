const fields = ["gatewayUrl", "capabilityToken"];

chrome.storage.local.get(fields).then((stored) => {
  for (const field of fields) {
    if (stored[field]) document.getElementById(field).value = stored[field];
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const field of fields) values[field] = document.getElementById(field).value.trim();
  await chrome.storage.local.set(values);
  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1500);
});
