# Auth Testing

## Admin credentials
- Email: jaki960119@gmail.hu
- Password: Admin1234

## API testing
```
curl -c cookies.txt -X POST http://localhost:8001/api/auth/login -H "Content-Type: application/json" -d '{"email":"jaki960119@gmail.hu","password":"Admin1234"}'
curl -b cookies.txt http://localhost:8001/api/auth/me
```
Login returns { token, user } and sets an access_token cookie. `/auth/me` works with cookie or Authorization: Bearer <token>.

## MongoDB
```
mongosh
use test_database
db.users.find({role: "admin"}).pretty()
```
Verify bcrypt hash starts with $2b$ and users.email has a unique index.
