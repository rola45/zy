const adminDialog = document.querySelector("#admin-login-dialog");
const adminForm = document.querySelector("#admin-access-form");
const adminError = document.querySelector("#admin-access-error");
const accountChoiceDialog = document.querySelector("#account-choice-dialog");

for (const trigger of document.querySelectorAll("#account-button, #open-account-choice-footer")) {
  trigger.addEventListener("click", event => {
    event.preventDefault();
    accountChoiceDialog.showModal();
  });
}

document.querySelector("[data-close-account-choice]").addEventListener("click", () => accountChoiceDialog.close());
accountChoiceDialog.addEventListener("click", event => { if (event.target === accountChoiceDialog) accountChoiceDialog.close(); });
document.querySelector("#choose-admin-access").addEventListener("click", () => {
  accountChoiceDialog.close();
  openAdminLogin();
});

function openAdminLogin() {
    adminError.textContent = "";
    adminDialog.showModal();
    adminForm.elements.password.focus();
}

document.querySelector("[data-close-admin-login]").addEventListener("click", () => adminDialog.close());
adminDialog.addEventListener("click", event => { if (event.target === adminDialog) adminDialog.close(); });

adminForm.addEventListener("submit", async event => {
  event.preventDefault();
  adminError.textContent = "";
  const password = new FormData(adminForm).get("password");
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo iniciar sesión.");
    window.location.assign("/admin");
  } catch (error) {
    adminError.textContent = error.message || "No se pudo iniciar sesión. Inténtalo de nuevo.";
  }
});
