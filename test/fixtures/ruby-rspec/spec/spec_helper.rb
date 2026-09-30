require "selenium-webdriver"

RSpec.configure do |c|
  c.formatter = :progress
  c.before(:each) { @driver = Selenium::WebDriver.for :chrome }
  c.after(:each) { @driver.quit }
end
