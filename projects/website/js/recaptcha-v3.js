/*
reCAPTCHA v3 for the contact forms.

Loads Google's api.js, then keeps a fresh token in a hidden g-recaptcha-response
field inside every .contact-form. js/views/view.contact.js reads that field
synchronously in its submitHandler, so the token has to be sitting there before
the visitor submits rather than fetched on demand.

v3 tokens expire after two minutes, hence the periodic refresh.

The site key is public by design -- it is meant to be visible in page source.
The matching secret key lives only in the RECAPTCHA_SECRET_KEY environment
variable on the server, and is what actually validates a submission.
*/

(function () {
	'use strict';

	// Replace with the v3 site key from https://google.com/recaptcha/admin
	var SITE_KEY = 'YOUR_RECAPTCHA_V3_SITE_KEY';

	var ACTION = 'contact';
	var REFRESH_MS = 90 * 1000; // under the 2 minute token lifetime
	var FIELD = 'g-recaptcha-response';

	if (!SITE_KEY || SITE_KEY === 'YOUR_RECAPTCHA_V3_SITE_KEY') {
		// Not configured yet. Leave the forms alone so they keep working; the
		// server skips verification while its secret key is unset.
		return;
	}

	var forms = document.querySelectorAll('.contact-form');
	if (!forms.length) {
		return;
	}

	// One hidden field per form. name= so jQuery's serializeArray picks it up,
	// id= because view.contact.js looks the value up by id.
	var fields = [];
	Array.prototype.forEach.call(forms, function (form) {
		var input = form.querySelector('[name="' + FIELD + '"]');
		if (!input) {
			input = document.createElement('input');
			input.type = 'hidden';
			input.name = FIELD;
			input.id = FIELD;
			form.appendChild(input);
		}
		fields.push(input);
	});

	function refresh() {
		if (!window.grecaptcha || !window.grecaptcha.execute) {
			return;
		}
		window.grecaptcha.execute(SITE_KEY, { action: ACTION }).then(
			function (token) {
				fields.forEach(function (input) {
					input.value = token;
				});
			},
			function (err) {
				// Leave the field empty; the server decides how to treat that.
				if (window.console) {
					console.error('reCAPTCHA execute failed:', err);
				}
			}
		);
	}

	var script = document.createElement('script');
	script.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(SITE_KEY);
	script.async = true;
	script.defer = true;
	script.onload = function () {
		window.grecaptcha.ready(function () {
			refresh();
			setInterval(refresh, REFRESH_MS);
		});
	};
	document.head.appendChild(script);
})();
