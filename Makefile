all:
	zip moz-spdy-indicator.xpi * -r chrome --exclude @exclude.lst

clean:
	rm *.xpi
