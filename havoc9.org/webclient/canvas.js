// The game canvas takes the right mouse button itself: no browser menu over it.
(function () {
  var canvas = document.getElementById("canvas");
  if (canvas) canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
})();
