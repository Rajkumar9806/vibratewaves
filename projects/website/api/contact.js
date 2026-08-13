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
