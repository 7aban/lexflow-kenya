# LexFlow Session & JWT Security

## Overview

LexFlow uses JSON Web Tokens (JWT) for authentication. This document describes the session security model, configuration options, and future improvements.

## Current Session Model (P3-Session-1)

### Access Tokens
- **Format**: JWT signed with HS256 algorithm
- **Storage**: Client-side (localStorage in browser)
- **Expiry**: Configurable via `JWT_EXPIRES_IN` (default: `1h` production, `8h` development)
- **Payload** (minimal):
  ```json
  {
    "userId": "U-...",
    "role": "admin|advocate|client",
    "email": "user@example.com",
    "fullName": "Display Name",
    "clientId": "C-..." (clients only)
  }
  ```

### Token Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required in prod) | Secret for signing tokens |
| `JWT_EXPIRES_IN` | `1h` (prod), `8h` (dev) | Token expiry duration |
| `JWT_ISSUER` | (optional) | Token issuer for validation |
| `JWT_AUDIENCE` | (optional) | Token audience for validation |

### Login Flow
1. User submits credentials
2. Server validates credentials
3. Server signs JWT with configured expiry
4. Server returns token and user info
5. Client stores token in localStorage
6. Client sends token in `Authorization: Bearer <token>` header

### Logout
- **Current behavior**: Client-side only (removes token from localStorage)
- **Server-side**: No token revocation (stateless JWT)
- **Recommendation**: Clear token from client storage; no server action needed

### Token Validation
- **Missing token**: 401 "Authentication required"
- **Invalid token**: 401 "Invalid token"
- **Expired token**: 401 "Token expired"
- **Wrong issuer/audience**: 401 "Invalid token" (if configured)

## Security Properties

### What's Protected
- All API routes require valid JWT (except login/register)
- Role-based access control (admin/advocate/client)
- Permission boundaries (matters, invoices, etc.) enforced per-user
- Token signature prevents tampering

### Current Limitations
1. **No server-side revocation**: Logged-out tokens remain valid until expiry
2. **No refresh token**: Single access token only
3. **No session tracking**: No visibility into active sessions
4. **No password change invalidation**: Old tokens remain valid after password change

## Production Recommendations

### Token Expiry
- **Production**: Set `JWT_EXPIRES_IN=1h` or `2h`
- **Development**: Default `8h` for convenience
- **Rationale**: Short-lived tokens limit exposure if compromised

### Secret Management
```bash
# Generate strong secret
openssl rand -hex 32

# Set in production environment
JWT_SECRET=your-32-byte-hex-secret
```

### Optional Hardening
```bash
# Add issuer validation
JWT_ISSUER=https://lexflow.co.ke

# Add audience validation
JWT_AUDIENCE=lexflow-api
```

## Future Improvements

### Refresh Token System (Post P3)
- Implement refresh token rotation
- Store refresh tokens in database
- Enable long-lived sessions with short-lived access tokens
- Allow token revocation

### Server-Side Session Management
- Track active sessions per user
- Allow users to view/revoke active sessions
- Invalidate tokens on password change
- Implement token blocklist for logout

### Two-Factor Authentication (2FA)
- TOTP (Time-based One-Time Password)
- SMS/Email verification
- Hardware key support (FIDO2/WebAuthn)

### Advanced Session Security
- Device fingerprinting
- Suspicious login detection
- Geolocation-based alerts
- Session expiration extension

## AI/Agents Readiness

Future AI and agentic workflows must:
- Use authenticated user context (never bypass JWT middleware)
- Respect all permission boundaries (matter, client, invoice scoping)
- Log all AI-generated actions with user attribution
- Never access tokens or secrets directly
- Use the same `req.user` context as standard requests

## Testing

### Current Test Coverage
- Login returns valid JWT
- Protected routes reject missing tokens (401)
- Protected routes reject invalid tokens (401)
- Protected routes reject expired tokens (401)
- Role-based access control works (403 for insufficient role)
- Permission boundaries enforced (403 for wrong matter/client)

### Test Configuration
- Test environment uses `JWT_EXPIRES_IN=1h`
- Test secret: `test-jwt-secret-for-unit-tests-only`
- Rate limiting disabled in test mode

## Migration Notes

If upgrading from pre-P3-Session-1:
1. Tokens now have configurable expiry (was hardcoded `8h`)
2. Token signing uses centralized `lib/tokens.js` helper
3. Verification enforces HS256 algorithm
4. Error messages are specific (expired vs invalid)
5. No breaking changes to login response shape

## Troubleshooting

### "Token expired"
- Check `JWT_EXPIRES_IN` setting
- Re-login to get fresh token
- Consider refresh tokens for longer sessions

### "Invalid token"
- Verify `JWT_SECRET` matches between token signing and verification
- Check token isn't malformed
- Verify issuer/audience if configured

### Still logged out after re-login
- Clear browser localStorage
- Check for multiple tabs with old tokens
- Verify token is being sent in request headers
