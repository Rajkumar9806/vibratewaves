// Contact form handler.
//
// Replaces php/contact-form.php, which cannot run on Vercel. Keeps the same
// contract the theme's JS expects (js/views/view.contact.js): POST of
// url-encoded form fields, JSON reply of {response:'success'} or
// {response:'error', errorMessage}.
//
// The reply is always HTTP 200. The theme reads the body from jQuery's
// .always() handler, where a non-2xx status makes the first argument the jqXHR
// rather than the parsed JSON, so an error status would hide errorMessage.

const nodemailer = require('nodemailer');

const MAILBOX = 'info@vibratewaves.com';

// Shown to the visitor. Deliberately generic: SMTP failures can carry host and
// credential detail, which the theme would render straight into the page.
const GENERIC_ERROR =
	'Sorry, your message could not be sent. Please email ' + MAILBOX + ' directly.';

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

// Collapse anything that would land in a header to a single clean line.
// Nodemailer already neutralises CRLF by RFC 2047-encoding it, so this is for
// legibility rather than safety: it keeps a hostile name from arriving as a
// wall of =0D=0A escapes.
function oneLine(value) {
	// Strip C0/C1 control characters, then collapse whitespace runs.
	return String(value)
		.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleCase(label) {
	return label.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Mirrors the PHP: every submitted field becomes a labelled line, checkbox
// arrays collapse to a comma-joined string.
function buildBody(fields) {
	return Object.entries(fields)
		.filter(([name]) => name !== 'g-recaptcha-response')
		.map(([name, value]) => {
			const joined = Array.isArray(value) ? value.join(', ') : value;
			const text = escapeHtml(joined).replace(/\r?\n/g, '<br>');
			return `${escapeHtml(titleCase(name))}: ${text}<br>`;
		})
		.join('');
}

// Left-most x-forwarded-for entry is the real client; the rest are proxy hops.
// Returns '' when the header is absent, which siteverify treats as optional.
function clientIp(req) {
	const header = req && req.headers ? req.headers['x-forwarded-for'] : '';
	if (!header) {
		return '';
	}
	return String(header).split(',')[0].trim();
}

// reCAPTCHA v3 verification.
//
// Returns null when the submission is allowed through, or a visitor-facing
// message when it is not.
//
// If RECAPTCHA_SECRET_KEY is unset, verification is skipped entirely so the
// form keeps working before the keys are configured. Set the secret to turn
// enforcement on.
async function verifyRecaptcha(token, remoteIp) {
	const secret = process.env.RECAPTCHA_SECRET_KEY;
	if (!secret) {
		return null;
	}

	if (!token) {
		// Usually a blocked or failed api.js load rather than a bot.
		console.warn('Contact form submitted without a reCAPTCHA token.');
		return 'Could not verify that you are human. Please reload the page and try again.';
	}

	const minScore = Number(process.env.RECAPTCHA_MIN_SCORE || '0.5');
	const body = new URLSearchParams({ secret, response: token });
	if (remoteIp) {
		body.set('remoteip', remoteIp);
	}

	let data;
	try {
		// Bound the wait: Google being slow must not hang the function.
		const signal = AbortSignal.timeout(10000);
		const reply = await fetch('https://www.google.com/recaptcha/api/siteverify', {
			method: 'POST',
			body,
			signal,
		});
		data = await reply.json();
	} catch (err) {
		// Fail open. A Google outage should not take the contact form down with
		// it; spam is the lesser problem.
		console.error('reCAPTCHA verification request failed, allowing through:', err);
		return null;
	}

	if (!data.success) {
		console.warn('reCAPTCHA rejected the token:', data['error-codes']);
		return 'Could not verify that you are human. Please reload the page and try again.';
	}

	// score and action are v3-only; a v2 token simply has neither.
	if (typeof data.score === 'number' && data.score < minScore) {
		console.warn(`reCAPTCHA score ${data.score} below threshold ${minScore}; rejecting.`);
		return 'Your message looked automated and was not sent. Please email ' + MAILBOX + ' instead.';
	}

	return null;
}

module.exports = async function handler(req, res) {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		return res.status(200).json({ response: 'error', errorMessage: 'Method not allowed.' });
	}

	const fields = req.body && typeof req.body === 'object' ? req.body : {};

	const name = typeof fields.name === 'string' ? oneLine(fields.name) : '';
	const email = typeof fields.email === 'string' ? fields.email.trim() : '';
	const message = typeof fields.message === 'string' ? fields.message.trim() : '';

	if (!name || !email || !message) {
		return res
			.status(200)
			.json({ response: 'error', errorMessage: 'Please complete all required fields.' });
	}

	// Loose check only; the browser already validated. Guards the Reply-To header.
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return res
			.status(200)
			.json({ response: 'error', errorMessage: 'Please enter a valid email address.' });
	}

	// After field validation so an incomplete form gets a useful message rather
	// than a captcha complaint, but before sending so a bot never reaches SMTP.
	const captchaError = await verifyRecaptcha(fields['g-recaptcha-response'], clientIp(req));
	if (captchaError) {
		return res.status(200).json({ response: 'error', errorMessage: captchaError });
	}

	const password = process.env.VW_SMTP_PASSWORD;
	if (!password) {
		console.error('VW_SMTP_PASSWORD is not set; cannot send contact form mail.');
		return res.status(200).json({ response: 'error', errorMessage: GENERIC_ERROR });
	}

	try {
		const transport = nodemailer.createTransport({
			host: 'smtp.hostinger.com',
			port: 465,
			secure: true, // implicit TLS
			auth: { user: MAILBOX, pass: password },
		});

		await transport.sendMail({
			// Hostinger authenticates the sender, so From must stay the mailbox
			// itself. The visitor's address goes on Reply-To.
			from: { name: `${name} (website)`, address: MAILBOX },
			to: MAILBOX,
			replyTo: { name, address: email },
			subject:
				typeof fields.subject === 'string' && fields.subject.trim()
					? oneLine(fields.subject)
					: `Website enquiry from ${name}`,
			html: buildBody(fields),
		});

		return res.status(200).json({ response: 'success' });
	} catch (err) {
		console.error('Contact form send failed:', err);
		return res.status(200).json({ response: 'error', errorMessage: GENERIC_ERROR });
	}
};
