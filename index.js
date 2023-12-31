// dependencies
const express = require("express");
const app = express();
const mime = require("mime-types");
const path = require("path");
const cookieParser = require("cookie-parser");
const mongo = require("mongoose");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken"); // auth tokens: https://jwt.io/introduction
const multer = require("multer"); // image handling
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { identity } = require("lodash");
const process = require("process");
const nodemailer = require("nodemailer");
const uuid = require("uuid");
const expressWs = require("express-ws")(app);
const WebSocket = require("ws");

//port
const port = 8080;

//websocket connections
let connected = new Set();

// middlewares
const setHeaders = function (req, res, next) {
  const filePath = path.join(__dirname, "public", req.path);
  const mimeType = mime.lookup(filePath);
  if (mimeType) {
    res.type(mimeType);
  }
  res.set("X-Content-Type-Options", "nosniff");
  next();
};
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "public/images/"); // no callback
  },
  filename: function (req, file, cb) {
    const originalNameWithoutExt = path.basename(
      file.originalname,
      path.extname(file.originalname).replace("/", "")
    );

    cb(
      null,
      originalNameWithoutExt + Date.now() + path.extname(file.originalname)
    );
  },
});

const img_save = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // Limit of 2MB
});

const limited_users = {};
const limiter = rateLimit({
  windowMs: 10000, // 10 seconds
  max: 50, // Limit each IP to 50 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    const now = Date.now();
    limited_users[req.ip] = now + 30000; // Block for 30 sec
    res
      .status(429)
      .send("429 Too many requests! You are blocked for 30 seconds.");
  },
});

// check if the user is blocked
app.use((req, res, next) => {
  const blockTime = limited_users[req.ip];
  if (Date.now() < blockTime) {
    return res
      .status(429)
      .send(
        `429 Too Many Requests! \n Blocked. Try again in ${
          (blockTime - Date.now()) / 1000
        } seconds`
      );
  }
  next();
});

app.use(setHeaders);
app.use(cookieParser());
app.use("/public", express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(limiter);
// connect to mongo
// useNewUrlParser: uses newer parser instead of legacy one
// useUnifiedTopology: use new topology engine
mongo.connect("mongodb://mongo:27017/312Not-Local", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// creates schema object
const Schema = mongo.Schema;
// creates a blueprint for collection of users
const user_schema = new Schema({
  name: String,
  creation_date: {
    type: Date,
    default: Date.now,
  },
  email: String,
  password: String,
  verfied: Boolean,
});

const auth_schema = new Schema({
  auth_key: String,
  creation_date: {
    type: Date,
    default: Date.now,
  },
  username: String,
});

const auction_schema = new Schema({
  item_name: String,
  image_path: String,
  creation_date: {
    type: Date,
    default: Date.now,
  },
  seller: String,
  description: String,
  current_bid: [String, Number], // [user,bid]
  price_history: {}, // inside price history [Date, User, Bid]
  winner: String,
  length: Number,
  id: String,
  finished: Boolean,
});
// creates a model, which is basically db["users"]
const User = mongo.model("users", user_schema);

const Auth = mongo.model("Auth", auth_schema);
//
const Auctions = mongo.model("Auction", auction_schema);
function escapeHTML(unsafeText) {
  return unsafeText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
// DATABASE CRUD
async function add_new_auction(
  seller,
  item,
  start_price,
  description,
  image_path,
  length
) {
  try {
    // console.log("Seller", seller);
    // console.log("Item", item);
    // console.log("Start price", start_price);
    // console.log("Desc", description);
    // console.log("Image path", image_path);
    // console.log("Length", length);

    const new_auction = new Auctions({
      seller: escapeHTML(seller),
      image_path: image_path,
      item_name: escapeHTML(item),
      description: escapeHTML(description),
      current_bid: [seller, start_price],
      length: length,
      id: Math.random().toString(36).substring(2, 15), // random id
      price_history: { [Date.now()]: [seller, start_price] },
      finished: false,
    });

    await new_auction.save();

    connected.forEach((client) => {
      console.log("client", client);
      if (client.readyState === WebSocket.OPEN) {
        console.log("client with open socket", client);
        client.send(JSON.stringify(new_auction));
      }
    });

    return new_auction.id; // return id for redirection purposes
  } catch (error) {
    console.log("Error saving new auction: ", error);
    return null;
  }
}

async function update_bid(user, bid, id) {
  if (user && bid && id) {
    //const pH = doc.price_history;
    let esc_user = await escapeHTML(user);
    let esc_bid = await escapeHTML(bid);
    await Auctions.findOneAndUpdate(
      { id: id },
      {
        $set: {
          current_bid: [esc_user, esc_bid],
          [`price_history.${new Date().toISOString()}`]: [esc_user, esc_bid],
        },
      }
    );
  }
}

async function add_new_user(username, password) {
  // async and await allow other processes to run while this is running
  // create a new document for user
  const esc_user = escapeHTML(username);
  const new_user = new User({
    name: esc_user,
    //email: email,
    password: password,
    verfied: false,
  });
  // hash pw
  new_user.password = await bcrypt.hash(password, 10);

  // save it to database
  await new_user
    .save() // can use save() or insertOne() but save() is more convenient
    .then(() => console.log("User saved: ", new_user["name"]))
    .catch((error) => console.error(error));
  console.log("Registering: ", esc_user);
}

async function emailVer(username) {
  await User.findOneAndUpdate(
    { name: username },
    {
      $set: {
        verified: true,
      },
    }
  );
}
async function verify_user(username, password) {
  const esc_user = escapeHTML(username);
  try {
    const fetched_data = await User.findOne({ name: esc_user });
    if (fetched_data) {
      const is_match = await bcrypt.compare(password, fetched_data.password); // returns a promise, await is needed for bool val
      if (is_match) {
        // this block of code checks if passwords match, if yes, send an auth token to client
        const metadata = {
          // metadata about token
          type: "user",
          name: esc_user,
        };
        const secret_key = "secret_key_to_sign_for_jwt";
        const auth_token = jwt.sign(metadata, secret_key, { expiresIn: "1h" });
        const auth_entry = new Auth({
          username: esc_user,
          auth_key: auth_token,
        });
        await auth_entry.save(); // save info into database
        return auth_token;
      } else {
        return "Invalid password!";
      }
    } else {
      return "User not found!";
    }
  } catch (error) {
    // catch whatever error for debuggings
    console.error(error);
    return "An error occurred while verifying the user.";
  }
}

async function token_checker(token) {
  const doc = Auth.findOne({ auth_key: token });
  if (doc) {
    return doc["username"];
  } else {
    return "";
  }
}
// Project 2
// async function getAllPosts() {
//   const posts = await Post.find({});
//   const jString = JSON.stringify(posts);
//   return jString;
// }
async function getAllItems() {
  const posts = await Auctions.find();
  //const jString = JSON.stringify(posts);
  return posts;
}

async function getUserWonAuctions(user) {
  try {
    //i want to find search for an element within an array
    let auctions = await Auctions.find({ current_bid: user });
    return auctions;
  } catch (error) {
    console.log("Error", error);
  }
}

async function getUserCreatedAuctions(user) {
  try {
    const uAuc = await Auctions.find({ seller: user });
    return uAuc;
  } catch {
    console.log("No auctions yet");
  }
}
// const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
// Set up Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "notlocal312@gmail.com", // Your Gmail address
    pass: "gtjn rbdc opok glho",
  },
});
const registeredUsers = [];
async function sendEmail(email, password, username) {
  console.log(email);
  // Check if the email is already registered
  if (registeredUsers.find((user) => user.email === email)) {
    return 0;
  }

  // Generate a unique verification token
  const verificationToken = uuid.v4();

  // Save the user data and verification token
  registeredUsers.push({ username, email, password, verificationToken });

  // Send a verification email
  const verificationLink = `https://notlocal.live/verify?token=${verificationToken}`;

  transporter.sendMail({
    from: "notlocal312@gmail.com",
    to: email,
    subject: "Email Verification",
    text: `Click on the following link to verify your email: ${verificationLink}`,
  });
  return 1;
}

// http requests

app.get("/visit-counter", (req, res) => {
  if (req.headers.cookie == undefined) {
    res.cookie("Visits", 1, { maxAge: 360000 });
  } else {
    splitCook = req.headers.cookie.split("=");
    cookValueStr = splitCook[1];
    cookValueInt = Number.parseInt(cookValueStr) + 1;
    res.cookie("Visits", cookValueInt, { maxAge: 360000 });
  }
  res.sendFile(path.join(__dirname, "public", "visit-counter.html"));
});

//gets
app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "public", req.path);
  res.sendFile(filePath);
});

app.ws("/", async (ws, req) => {
  connected.add(ws);
  console.log("ws connected! currently conns:", connected);
  ws.on("close", () => {
    console.log("ws dc'd! dc'd conn:", ws);
    connected.delete(ws);
  });

  ws.on("error", (err) => {
    console.log("error with websocket conn!", err);
  });
}); // default page ws

//app.ws("/new-bid")

app.get("/user_check", (req, res) => {
  const username = req.cookies["username"];
  // console.log("logged user is:" +username)
  res.send({ username: username });
});

// Loads Users auctions created
app.get("/auctionsCreated", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auctionsCreated.html"));
});

app.get("/loadAuctionsCreated", async (req, res) => {
  try {
    username = req.cookies["username"];
    username = escapeHTML(username);
    console.log(username);
    let aucts = await getUserCreatedAuctions(username);
    res.send(JSON.stringify(aucts));
  } catch {
    res.send("User is guest");
  }
});

// Loads Users auctions won
app.get("/auctionsWon", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auctionsWon.html"));
});

app.get("/loadAuctionsWon", async (req, res) => {
  try {
    username = req.cookies["username"];
    username = escapeHTML(username);
    let aucts = await getUserWonAuctions(username);
    console.log("Aucts from won auctions", aucts);
    res.send(JSON.stringify(aucts));
  } catch {
    res.send("user is guest");
  }
});

// app.get("/user_check", (req, res) => {
//   const token_cookie = req.cookies["token_cookie"];
//   res.send(token_checker(token_cookie));
// });

app.get("/update-feed", (req, res) => {
  posts = getAllPosts();
  posts.then(function (result) {
    res.json(result);
  });
});

app.get("/auction-page", async (req, res) => {
  // serve the html

  // const auction_data = await Auctions.findOne({ id: id });
  const auction_page_path = path.join(__dirname, "public", "auction_page.html");
  res.sendFile(auction_page_path);
});

app.get("/get-auction-data", async (req, res) => {
  const queries = req.query;
  //console.log("QUERIES", queries);
  let id = queries["id"];

  //console.log("id in indexjs", id);
  const auction_data = await Auctions.findOne({ id: id });
  //console.log("Auction data", auction_data);
  if (!auction_data) {
    return res.status(400).send("Auction not found!");
  }
  //console.log("curr_bid", auction_data["current_bid"]);

  res.send(JSON.stringify(auction_data));
});

app.get("/items", async (req, res) => {
  const items = await Auctions.find({ finished: false });
  console.log(items);
  res.send(JSON.stringify(items));
});

// posts
app.post("/register", async (req, res) => {
  const name = req.body.username_reg;
  const password = req.body.password_reg;
  var email = req.body.email_reg;
  email = escapeHTML(email);
  if (!name || !password) {
    return res.status(400).send("All fields are required!");
  }
  try {
    const user_document = await User.findOne({ name: name }); // await the database fetch
    //console.log("User document", user_document);
    if (user_document) {
      return res.status(400).send("Username already exists!"); // if user exists, throw this err
    }
    regEm = await add_new_user(name, password); // idk if await should be there
    if(email){
      sendEmail(email, password, name);
    }
    res.cookie("verified", "Not Verified", {
      maxAge: 3600000, // one hour in milliseconds
      sameSite: "strict",
    });
    // if (sendEmail(email,password,name) == 0) {
    //   res.status(400).send('Email already registered')}
    // else if (sendEmail(email,password,name) == 1){
    if (email){
    res.send("Registration successful. Check your email for verification instructions.");
    }
    else{
      res.send("Registration successful.");
    }
    // }
  } catch (error) {
    console.error("Error occurred:", error); // log error for debugging
    res.status(500).send("A server error has occurred: " + String(error));
  }
});

app.post("/login", async (req, res) => {
  const user_login = escapeHTML(req.body.username_login);
  const pass_login = req.body.password_login;
  const user_verification = await verify_user(user_login, pass_login);
  console.log(user_verification);
  if (
    user_verification !== "User not found!" &&
    user_verification !== "Invalid password!"
  ) {
    res
      .cookie("token_cookie", user_verification, {
        maxAge: 3600000, // one hr in ms
        httpOnly: true,
        sameSite: "strict", // no cross-site cookie viewing
      })
      .cookie("username", user_login, {
        // dont set httponly, so it is readable by the client
        maxAge: 3600000, // one hour in milliseconds
        sameSite: "strict",
      })
      .send("Login successful!\n" + "Logged in: " + user_login);
  } else {
    res.status(401).send(user_verification);
  }
});

app.get("/settled-auctions", async (req, res) => {
  const all = await Auctions.find();
  res.send(JSON.stringify(all));
});

// Define a route for email verification
app.get("/verify", (req, res) => {
  const { token } = req.query;

  // Find the user with the corresponding verification token
  const user = registeredUsers.find((u) => u.verificationToken === token);
  if (!user) {
    // return res.status(400).send('Invalid or expired verification token');
    return res.send("Not verified");
  }
  try {
    emailVer(user.username);
    console.log(`Email verified for user: ${user.email}`);
    // Remove the verification token from the user data
    user.verificationToken = null;
    res.cookie("verified", "Verified User", {
      maxAge: 36000000000000000000000, // one hour in milliseconds
      sameSite: "strict",
    });
    res.send("Email verified successfully");
  } catch {
    console.log("big error");
  }
});
app.post("/make-post", bodyParser.json(), (req, res) => {
  console.log(req.body["title"]);
  title = req.body["title"];
  description = req.body["description"];
  token_cookie = req.cookies["username"];
  if (token_cookie) {
    add_new_post(token_cookie, title, description);
  }
  res.send("New POST Made");
});

// ...

app.post("/like", bodyParser.json(), async (req, res) => {
  const postId = req.body.likeId;
  const username = req.cookies["username"];

  try {
    const post = await Post.findOne({ _id: postId });
    if (!post) {
      return res.status(404).send("Post not found");
    }

    if (!post.users_liked.includes(username)) {
      post.users_liked.push(username);
      post.liked = true;
      await post.save();
      return res.send("Post liked");
    }
    return res.send("Post already liked");
  } catch (error) {
    console.error("Error occurred:", error);
    return res.status(500).send("A server error has occurred");
  }
});

app.post("/unlike", bodyParser.json(), async (req, res) => {
  const postId = req.body.likeId;
  const username = req.cookies["username"];

  try {
    const post = await Post.findOne({ _id: postId });
    if (!post) {
      return res.status(404).send("Post not found");
    }

    const index = post.users_liked.indexOf(username);
    if (index > -1) {
      post.users_liked.splice(index, 1);
      post.liked = false;
      await post.save();
      return res.send("Post unliked");
    }
    return res.send("Post not liked by the user");
  } catch (error) {
    console.error("Error occurred:", error);
    return res.status(500).send("A server error has occurred");
  }
});

app.post("/new-bid", async (req, res) => {
  //console.log("Req body", req.body);
  const req_body = req.body;
  let user = req_body["user"];
  let bid = req_body["bid"];
  let id = req_body["id"];

  const auc_from_id = await Auctions.findOne({ id: id });
  let db_bid = auc_from_id["current_bid"][1];

  if (bid <= db_bid) {
    return res.status(409).send();
  }

  await update_bid(user, bid, id);
  res.status(200).send();
});
// seller,
//   item,
//   start_price,
//   description,
//   image_path
app.post("/submit-auction", img_save.single("item_image"), async (req, res) => {
  let multerDirectory = "public/images/";
  fs.readdir(multerDirectory, (err, files) => {
    if (err) {
      console.error("Error reading the directory: ", err);
      return;
    }

    console.log(`Contents of ${multerDirectory}:`);
    files.forEach((file) => {
      console.log(file);
    });
  });
  const username = req.cookies.username;
  const end_time = req.body.auction_end_time; // 8 hours
  console.log(end_time);
  let date = new Date(end_time);
  let auction_end = date.getTime() + 21600000 - 3563686;
  if (!username) {
    return res.status(400).send("Not logged in!");
  }
  if (
    !req.body.item_title ||
    !req.body.starting_price ||
    !req.body.item_description
  ) {
    return res.status(400).send("All fields must be filled!");
  }
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }
  //let fiveHoursFromNow = Date.now() + 5 * 60 * 60 * 1000;
  if (auction_end < Date.now()) {
    return res.status(400).send("Enter a valid date!");
  }
  let converted_length = auction_end - Date.now(); // endtime - curr = length
  let id = await add_new_auction(
    username,
    req.body.item_title,
    req.body.starting_price,
    req.body.item_description,
    req.file.filename,
    converted_length
  );
  let url = req.protocol + "://" + req.get("host") + "/auction-page?id=" + id;

  res.status(200).redirect(url);
});

//items page
app.get("/getItems", async (req, res) => {
  items = getAllItems;
  print(items);
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
