// The forge serves exactly one authenticated account: the login the shop
// token names. The trial harness addresses every repository as
// /repos/{viewer}/{name} and asks GraphQL `viewer { login }`, so the forge
// must know that login. It is a published constant of the competition's
// scenario (derived from the fixed scenario seed in the kit's wire format
// spec): the account below is the token's owner for every trial.
//
//   viewer   adaiversen  (id 1000, "ada iversen")
//   teammate quinnkeller (id 1001)
//   stranger olgabauer   (id 1002)
//   org      faint-meadow-org

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const TEAMMATE = {
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
};

export const STRANGER = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

export const ORG_LOGIN = 'faint-meadow-org';
