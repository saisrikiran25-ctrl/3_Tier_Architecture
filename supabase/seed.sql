-- Between the Tiers: the five quiz questions and their answer key.
-- Run after schema.sql. Safe to run again: it updates the questions in place.
-- correct_idx is the position (0 to 3) of the right answer inside options.

insert into questions (id, position, tag, prompt, options, correct_idx, explanation, slide) values
(1, 1, 'Tier rules',
 'A customer clicks Place Order in the browser. In a three-tier architecture, which tier may the browser talk to directly?',
 '["The application tier only", "The database tier only", "Both the application tier and the database tier", "Neither: the browser only talks to other browsers"]',
 0,
 'The client talks only to the application tier, and the database talks only to the application tier. A direct path from client to database must not exist.',
 4),
(2, 2, 'Thin client',
 'Why is a web browser called a thin client?',
 '["Its files are very small", "It only presents information and sends input; the business rules and data stay on the server", "It stores a full copy of the database locally", "It works fully offline"]',
 1,
 'A thin client does presentation work only. The trade-off: it depends heavily on the network and the server, so with no connection it can do almost nothing.',
 5),
(3, 3, 'Web languages',
 'A visitor chooses “view source” on the order-confirmation page. What can they see?',
 '["The Java or PHP program that built the page", "The SQL statements sent to the database", "Only the HTML the server sent, never the server-side program that produced it", "The code of the stored procedure"]',
 2,
 'Server-side code runs on the server and sends only its result to the browser. That is also a security benefit.',
 7),
(4, 4, 'Stored procedures',
 'Illustrative numbers: an order needs 5 SQL statements and each network round trip takes 2 ms. Roughly how much network time does one PlaceOrder stored-procedure call need instead?',
 '["10 ms", "5 ms", "2 ms", "0 ms"]',
 2,
 'Five statements sent one by one cost about 5 × 2 = 10 ms. One procedure call is one trip: about 1 × 2 = 2 ms. The numbers are made up to show the principle, not measurements.',
 11),
(5, 5, 'Transactions',
 'The system crashes halfway through placing an order. Which ACID property makes sure the order and the stock update are saved together or not at all?',
 '["Atomicity", "Consistency", "Isolation", "Durability"]',
 0,
 'Atomicity means all steps happen or none do. Consistency keeps stock from going below zero, isolation stops two buyers taking the last phone, and durability keeps a saved order through a crash.',
 9)
on conflict (id) do update set
  position = excluded.position, tag = excluded.tag, prompt = excluded.prompt, options = excluded.options,
  correct_idx = excluded.correct_idx, explanation = excluded.explanation, slide = excluded.slide;
